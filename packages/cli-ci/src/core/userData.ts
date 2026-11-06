// The cloud-config an instance boots with (§ 8 PLX-Delivery), as text: a
// runner's, with every teardown layer. The placeholders `@@NAME@@` are filled
// by render(); a leftover placeholder is an error. Kept as string constants so that the bundle carries them and the
// tests render them without a loader. The cloud-config itself is documented
// inline; edit here, nowhere else.
import { UsageError } from '@plexus-ms/lib';

export const RUNNER_USER_DATA = `#cloud-config
# One throwaway CI runner (PLX-Delivery, § 8). Rendered by plx-ci hybrid
# create-instances, which fills the placeholders. Every teardown layer is
# armed here, before the runner exists:
#
#   layer 1   the runner exits after its one job, the instance deletes itself
#   layer 1b  noJobTimeout, @@NO_JOB_MINUTES@@ minutes after boot with no job ever started,
#             the instance deletes itself
#   layer 2b  deathTimeout, @@DEATH_MINUTES@@ minutes after boot, a mail, then self-delete
#   layer 2a  @@POWEROFF_MINUTES@@ minutes after boot, power-off, a timer
#             armed with the others as the first run command; the daily
#             sweep removes a stopped instance
#
# No bootcmd: a scheduled \`shutdown\` there runs before logind exists, and
# cloud-init never got past it (the hostname stayed \`localhost\`, no network,
# no SSH), so every layer is a systemd timer started in runcmd.
#
# The self-delete key and the registry bucket's write key sit in
# /etc/plexus-ci/env, readable by root; the job that runs here could read
# them anyway (§ 8 PLX-Delivery).
hostname: @@LABEL@@

write_files:
  - path: /etc/plexus-ci/env
    permissions: "0600"
    content: |
      EXOSCALE_API_KEY=@@SELF_DELETE_KEY@@
      EXOSCALE_API_SECRET=@@SELF_DELETE_SECRET@@
      SELF_LAYERS=@@SELF_LAYERS@@
      ZONE=@@ZONE@@
      LABEL=@@LABEL@@
      KIND=@@KIND@@
      APP=@@APP@@
      REPO=@@REPO@@
      RUN=@@RUN@@
      SMTP_HOST=@@SMTP_HOST@@
      SMTP_PORT=@@SMTP_PORT@@
      SMTP_USER=@@SMTP_USER@@
      SMTP_PASSWORD=@@SMTP_PASSWORD@@
      MAIL_FROM=@@MAIL_FROM@@
      MAIL_TO=@@MAIL_TO@@
      REGISTRY_ENDPOINT=@@REGISTRY_ENDPOINT@@
      REGISTRY_REGION=@@REGISTRY_REGION@@
      REGISTRY_BUCKET=@@REGISTRY_BUCKET@@
      REGISTRY_PREVIOUS_BUCKET=@@REGISTRY_PREVIOUS_BUCKET@@
      REGISTRY_ACCESS_KEY=@@REGISTRY_ACCESS_KEY@@
      REGISTRY_SECRET_KEY=@@REGISTRY_SECRET_KEY@@
      RUNNER_VERSION=@@RUNNER_VERSION@@
      RUNNER_SHA256=@@RUNNER_SHA256@@
      EXO_VERSION=@@EXO_VERSION@@
  - path: /etc/plexus-ci/jitconfig
    permissions: "0600"
    content: "@@JITCONFIG@@"

  # exo, fetched on demand so that self-delete works before runcmd got to it.
  # The env file is sourced exported (set -a): exo reads the key from the
  # environment, and a plain source would leave it shell-local. A timer's
  # service has no HOME, and exo refuses to run without one (layers 1b and
  # 2b failed on it on 2026-11-04); the runner's unit has a user.
  - path: /usr/local/sbin/plexus-ci-exo
    permissions: "0755"
    content: |
      #!/bin/sh
      set -eu
      set -a; . /etc/plexus-ci/env; set +a
      export HOME="\${HOME:-/root}"
      if [ ! -x /usr/local/bin/exo ]; then
        curl -fsSL "https://github.com/exoscale/cli/releases/download/v\${EXO_VERSION}/exoscale-cli_\${EXO_VERSION}_linux_amd64.tar.gz" \\
          | tar -xz -C /usr/local/bin exo
      fi
      exec /usr/local/bin/exo "$@"

  - path: /usr/local/sbin/plexus-ci-mail
    permissions: "0755"
    content: |
      #!/bin/sh
      # plexus-ci-mail <subject> <text>: one mail through the tenant's SMTP
      # relay (Scaleway TEM: the project id is the user, the key the password,
      # the narrowest scope a TEM key can have). Skipped, and logged, while
      # the relay or the addresses are not configured.
      set -eu
      set -a; . /etc/plexus-ci/env; set +a
      if [ -z "$SMTP_HOST" ] || [ -z "$MAIL_FROM" ] || [ -z "$MAIL_TO" ]; then
        logger -t plexus-ci "mail not configured, not sending: $1"; exit 0
      fi
      case "$SMTP_PORT" in 465|2465) url="smtps://$SMTP_HOST:$SMTP_PORT" ;; *) url="smtp://$SMTP_HOST:$SMTP_PORT" ;; esac
      printf 'From: plexus-ci <%s>\\r\\nTo: %s\\r\\nSubject: %s\\r\\nDate: %s\\r\\n\\r\\n%s\\r\\n' \\
        "$MAIL_FROM" "$MAIL_TO" "$1" "$(date -R)" "$2" > /run/plexus-ci-mail.txt
      curl -fsS --ssl-reqd --url "$url" --mail-from "$MAIL_FROM" --mail-rcpt "$MAIL_TO" \\
        --user "$SMTP_USER:$SMTP_PASSWORD" --upload-file /run/plexus-ci-mail.txt \\
        || logger -t plexus-ci "mail failed: $1"
      rm -f /run/plexus-ci-mail.txt

  - path: /usr/local/sbin/plexus-ci-self-delete
    permissions: "0755"
    content: |
      #!/bin/sh
      # Deletes this instance with the self-delete key; its id comes from the
      # metadata service. Logged either way; a failure leaves layers 2a and 5.
      set -u
      set -a; . /etc/plexus-ci/env; set +a
      # SELF_LAYERS=off (the launch's SELF_LAYERS, while the boot stall is
      # investigated): layers 1, 1b and 2b log and do nothing; the
      # power-off, the teardown job and the sweep remain.
      [ "\${SELF_LAYERS:-on}" != off ] || { logger -t plexus-ci "self-delete ($1): layers off, not deleting"; exit 0; }
      id=$(curl -fsS --max-time 10 http://metadata.exoscale.com/latest/meta-data/instance-id) || id=
      logger -t plexus-ci "self-delete ($1): instance \${id:-unknown}"
      [ -n "$id" ] && plexus-ci-exo compute instance delete "$id" -z "$ZONE" -f -Q 2>&1 | logger -t plexus-ci \\
        || logger -t plexus-ci "self-delete ($1) failed"

  - path: /usr/local/sbin/plexus-ci-no-job
    permissions: "0755"
    content: |
      #!/bin/sh
      # Layer 1b: the runner spawns a Worker process for a job and nothing
      # else, and logs it as _diag/Worker_*.log; _work itself exists empty
      # from the runner's start (seen 2026-11-04). No Worker log by
      # now means no job ever came, and nothing will.
      set -u
      if ! ls /opt/runner/_diag/Worker_*.log >/dev/null 2>&1; then
        logger -t plexus-ci "no job started, deleting"
        exec plexus-ci-self-delete no-job
      fi

  - path: /usr/local/sbin/plexus-ci-death
    permissions: "0755"
    content: |
      #!/bin/sh
      # Layer 2b: past the programmed death time, whatever is running here.
      set -u
      set -a; . /etc/plexus-ci/env; set +a
      [ "\${SELF_LAYERS:-on}" != off ] || { logger -t plexus-ci "death: layers off, no mail, not deleting"; exit 0; }
      plexus-ci-mail "plexus-ci: $LABEL past its deadline" \\
        "The instance $LABEL ($KIND, app $APP, $REPO run $RUN) reached its deathTimeout of @@DEATH_MINUTES@@ minutes and deletes itself. A job was still running or never ended; look at the run."
      exec plexus-ci-self-delete death

  - path: /etc/systemd/system/plexus-ci-no-job.service
    content: |
      [Unit]
      Description=plexus-ci: delete the instance when no job started in time
      [Service]
      Type=oneshot
      ExecStart=/usr/local/sbin/plexus-ci-no-job
  - path: /etc/systemd/system/plexus-ci-no-job.timer
    content: |
      [Unit]
      Description=plexus-ci: layer 1b
      [Timer]
      OnBootSec=@@NO_JOB_MINUTES@@min
      AccuracySec=10s
      [Install]
      WantedBy=timers.target
  - path: /etc/systemd/system/plexus-ci-poweroff.service
    content: |
      [Unit]
      Description=plexus-ci: power off at the hard deadline
      [Service]
      Type=oneshot
      ExecStart=/usr/bin/systemctl poweroff
  - path: /etc/systemd/system/plexus-ci-poweroff.timer
    content: |
      [Unit]
      Description=plexus-ci: layer 2a
      [Timer]
      OnBootSec=@@POWEROFF_MINUTES@@min
      AccuracySec=10s
      [Install]
      WantedBy=timers.target
  - path: /etc/systemd/system/plexus-ci-death.service
    content: |
      [Unit]
      Description=plexus-ci: mail and delete the instance at its death time
      [Service]
      Type=oneshot
      ExecStart=/usr/local/sbin/plexus-ci-death
  - path: /etc/systemd/system/plexus-ci-death.timer
    content: |
      [Unit]
      Description=plexus-ci: layer 2b
      [Timer]
      OnBootSec=@@DEATH_MINUTES@@min
      AccuracySec=10s
      [Install]
      WantedBy=timers.target

  # Frees the dpkg lock for the run commands. The image is weeks old, so
  # apt-daily-upgrade's persistent timer catches up seconds into the boot, and
  # unattended-upgrades then holds the lock for about a minute: every apt-get
  # here failed at once, there was no docker and no runner user, and the
  # launch kept the instance as a stalled boot. Waiting on the lock costs that
  # minute, so the instance, which lives under an hour, masks the apt timers
  # and services (they never start after this), kills whatever of them
  # already runs, dpkg children included (systemctl kill takes the unit's
  # whole cgroup), and lets dpkg finish what a kill interrupted. Masking alone
  # is not enough: the catch-up can start before any run command does, and
  # bootcmd is out (see above).
  - path: /usr/local/sbin/plexus-ci-apt-free
    permissions: "0755"
    content: |
      #!/bin/sh
      units='apt-daily.timer apt-daily-upgrade.timer apt-daily.service apt-daily-upgrade.service unattended-upgrades.service'
      systemctl mask $units >/dev/null 2>&1
      systemctl kill --signal=KILL apt-daily.service apt-daily-upgrade.service unattended-upgrades.service 2>/dev/null
      i=0
      while pgrep -x 'unattended-upgr|apt\\.systemd\\.dai|apt-get|apt|dpkg' >/dev/null && [ "$i" -lt 10 ]; do
        sleep 1; i=$((i + 1))
      done
      systemctl stop $units 2>/dev/null
      dpkg --configure -a
      logger -t plexus-ci "apt-free: apt timers masked, dpkg lock free after \${i}s"

  # The runner, one job, then layer 1: ExecStopPost runs as root (the +) when
  # the runner exits for any reason.
  - path: /etc/systemd/system/plexus-ci-runner.service
    content: |
      [Unit]
      Description=plexus-ci: GitHub Actions runner @@LABEL@@, one job
      After=network-online.target docker.service
      Wants=network-online.target
      [Service]
      Type=simple
      User=runner
      WorkingDirectory=/opt/runner
      Environment=HOME=/home/runner
      ExecStart=/bin/sh -c 'exec ./run.sh --jitconfig "$(cat /etc/plexus-ci/jitconfig)"'
      ExecStopPost=+/usr/local/sbin/plexus-ci-self-delete runner-exit
      KillMode=process
      TimeoutStopSec=2min

runcmd:
  # Layers 1b, 2b and 2a first, before anything that can hang.
  - systemctl daemon-reload
  - systemctl start plexus-ci-no-job.timer plexus-ci-death.timer plexus-ci-poweroff.timer
  - plexus-ci-apt-free
  - export DEBIAN_FRONTEND=noninteractive; apt-get update -q && apt-get install -yq --no-install-recommends ca-certificates curl jq git tar unzip
  - curl -fsSL https://get.docker.com | sh
  - useradd -m -s /bin/bash -G docker runner && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner
  - cp /etc/plexus-ci/jitconfig /etc/plexus-ci/jitconfig.runner && chown runner:runner /etc/plexus-ci/jitconfig.runner && mv /etc/plexus-ci/jitconfig.runner /etc/plexus-ci/jitconfig
  - . /etc/plexus-ci/env && mkdir -p /opt/runner && cd /opt/runner && curl -fsSLo runner.tgz "https://github.com/actions/runner/releases/download/v\${RUNNER_VERSION}/actions-runner-linux-x64-\${RUNNER_VERSION}.tar.gz" && echo "\${RUNNER_SHA256}  runner.tgz" | sha256sum -c - && tar -xzf runner.tgz && rm runner.tgz && ./bin/installdependencies.sh >/dev/null && chown -R runner:runner /opt/runner
  - plexus-ci-exo version >/dev/null
  # The registry sidecars, when the launch named a bucket (§ 8 PLX-Delivery): :5000 on this month's bucket, read-write; :5001 on the previous month's, read-only. The same two containers as .github/ci/registry.sh starts on a GitHub runner.
  - . /etc/plexus-ci/env && if [ -n "$REGISTRY_ENDPOINT" ]; then docker run -d --name registry --restart unless-stopped -p 127.0.0.1:5000:5000 -e REGISTRY_STORAGE=s3 -e REGISTRY_STORAGE_S3_REGIONENDPOINT="$REGISTRY_ENDPOINT" -e REGISTRY_STORAGE_S3_REGION="$REGISTRY_REGION" -e REGISTRY_STORAGE_S3_BUCKET="$REGISTRY_BUCKET" -e REGISTRY_STORAGE_S3_ACCESSKEY="$REGISTRY_ACCESS_KEY" -e REGISTRY_STORAGE_S3_SECRETKEY="$REGISTRY_SECRET_KEY" -e REGISTRY_STORAGE_S3_FORCEPATHSTYLE=true -e REGISTRY_STORAGE_DELETE_ENABLED=true registry:2 >/dev/null; fi
  - . /etc/plexus-ci/env && if [ -n "$REGISTRY_ENDPOINT" ]; then docker run -d --name registry-previous --restart on-failure:3 -p 127.0.0.1:5001:5000 -e REGISTRY_STORAGE=s3 -e REGISTRY_STORAGE_S3_REGIONENDPOINT="$REGISTRY_ENDPOINT" -e REGISTRY_STORAGE_S3_REGION="$REGISTRY_REGION" -e REGISTRY_STORAGE_S3_BUCKET="$REGISTRY_PREVIOUS_BUCKET" -e REGISTRY_STORAGE_S3_ACCESSKEY="$REGISTRY_ACCESS_KEY" -e REGISTRY_STORAGE_S3_SECRETKEY="$REGISTRY_SECRET_KEY" -e REGISTRY_STORAGE_S3_FORCEPATHSTYLE=true -e 'REGISTRY_STORAGE_MAINTENANCE_READONLY={"enabled":true}' registry:2 >/dev/null; fi
  # A builder: the docker driver cannot export a registry cache, so BuildKit runs in its own container on the host's network, where localhost:5000 is the sidecar; bootstrapped now so that the build does not wait for it.
  - . /etc/plexus-ci/env && if [ "$KIND" = build ]; then su -s /bin/bash runner -c 'docker buildx create --name ci --driver docker-container --driver-opt network=host --bootstrap >/dev/null' & fi
  - . /etc/plexus-ci/env && if [ "$KIND" = test ]; then docker pull -q postgres:18.6 >/dev/null & docker pull -q rustfs/rustfs:1.0.4 >/dev/null & fi
  - systemctl start plexus-ci-runner.service
`;

/** The placeholders a template names, in order of appearance, each once. */
export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/@@([A-Z0-9_]+)@@/g)].map((m) => m[1] ?? ''))].filter((n) => n !== '');
}

/**
 * Fill the placeholders; every `@@NAME@@` needs a value (an empty string is
 * one), and a value is written as it is, so a secret with `@@` in it would
 * break the template, which no key of ours has.
 */
export function render(template: string, values: Record<string, string>): string {
  const text = template.replace(/@@([A-Z0-9_]+)@@/g, (match, name: string) => values[name] ?? match);
  const left = placeholders(text);
  if (left.length > 0) throw new UsageError(`a placeholder stayed in the user-data: ${left.join(' ')}`);
  return text;
}
