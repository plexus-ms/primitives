# The runner image of a runner host's container slots (§ 8 PLX-Delivery,
# ci_runner_host), one image for every size: the official runner image plus
# what the jobs expect of GitHub's runners and the official image leaves
# out. One container runs one job and is removed after it; nothing here is a
# cache or a secret. Built and pushed by runner-image.yml as
# ghcr.io/plexus-ms/ci-runner at the train number, with provenance, or built
# on the host itself (ci_runner_host_image_build); Renovate moves the base.
#
# The tools the jobs install themselves (mise and what it pins, exo, crane,
# the 1Password CLI) stay the jobs' business: a slot runs the same steps as
# a GitHub runner, and a version here would be a second pin of each.
#
# A large slot runs a Docker daemon inside its container (ci-runner-dind).
# The official image carries Docker's static binaries, the daemon among
# them, and buildx; what the daemon and the jobs need beyond is here:
# iptables for the daemon's networks, and the compose plugin for the test
# stacks.
FROM ghcr.io/actions/actions-runner:2.338.2@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232

USER root
# git for actions/checkout (without it the action downloads a tarball and
# later git commands fail), jq and unzip for the jobs' own steps and the
# 1Password action, zstd for the cache actions, gnupg for apt keys, iptables
# for the daemon of a large slot.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg iptables jq unzip zstd \
 && rm -rf /var/lib/apt/lists/*
# renovate: datasource=github-releases depName=docker/compose
ARG COMPOSE_VERSION=v5.7.0
ARG COMPOSE_SHA256=7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2
RUN curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
      "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
 && echo "${COMPOSE_SHA256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c - \
 && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose
COPY --chmod=0755 ci-runner-dind /usr/local/bin/ci-runner-dind
USER runner
WORKDIR /home/runner
