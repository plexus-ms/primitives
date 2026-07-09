# plexus.itops — the shared Plexus tenant-host roles

The Ansible collection every Plexus tenant playbook binds to its own inventory
(§ 7 PLX). Note the namespace is `plexus`, not `plexus-ms` — collection
namespaces forbid hyphens, so it deliberately differs from the GitHub org
spelling; do not "fix" it.

| Role | What |
|---|---|
| `plexus.itops.base` | Hardening: deploy user + authorized keys, key-only SSH, ufw (22/80/443), fail2ban, unattended-upgrades, mise. |
| `plexus.itops.docker` | Docker engine + compose plugin (deb822 repo, conflicting distro packages removed); deploy user in the `docker` group; opt-in `docker_daemon_json`. |
| `plexus.itops.caddy` | Caddy ingress with automatic HTTPS, reverse-proxying the `apps` list. |
| `plexus.itops.deploy` | Per app: place `compose.yml` + `mise.toml`, seed `.env` (restore baseline), GHCR login, pull + start as the deploy user. |
| `plexus.itops.alloy` | Grafana Alloy agent: node + cAdvisor metrics, Docker/journal logs, Prometheus remote_write + Loki push, `instance`/`project` labels. Run it **after** `docker` (joins the `docker` group). Not yet wired into the standard `site.yml` (doctrine Phase 3). |

## Consumption

```yaml
# infra/requirements.yml
collections:
  - name: https://github.com/plexus-ms/itops.git#/ansible/
    type: git
    version: v1
```

```yaml
# infra/site.yml
  roles:
    - plexus.itops.base
    - plexus.itops.docker
    - plexus.itops.caddy
    - plexus.itops.deploy
```

`ansible-galaxy collection install -r requirements.yml` (add `--force` to pick
up a moved tag). Dependencies (`community.general`, `ansible.posix`) install
automatically.

## Contracts and conventions

- **Layout contract:** the `deploy` role copies deploy artifacts from
  `{{ playbook_dir }}/../apps/<name>/` — it assumes the standard tenant-monorepo
  shape (`infra/` beside `apps/`, § 4.3 PLX).
- **All tenant substance is parameters.** Roles read only group_vars/inventory
  variables (`tenant`, `deploy_user`, `apps`, `base_packages`, `plexus_root`,
  `app_deploy`) and run-time env-injected secrets (`deploy_authorized_key`,
  `ghcr_user`/`ghcr_token`, `alloy_basicauth_password` via `op run`). Nothing
  tenant-specific may ever be committed here — this collection is public.
- **Versioning:** bump `galaxy.yml` `version` with every change (SCM installs
  record it; a moved tag alone won't reinstall), then move the repo tag.
