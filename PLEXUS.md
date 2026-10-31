---
plexus: 0.76.0
modules: [PLX-Repo, PLX-JS, PLX-Updates]
---

- `primitives` ships the methodology's primitives (§ 1.6 PLX): the `plexus.platform` Ansible collection and the Terraform modules under `ansible/` and `terraform/`, the reusable workflows under `.github/workflows/_*.yml`, the train-versioned packages `@plexus-ms/{cli,lib,config}` under `packages/`, and the shared Renovate preset under `renovate/`.
  It rides the train (§ 1.5 PLX): the tag is the collection's version, the workflows' ref, and the packages' version on npm.
- Two toolchains in one repo: the JS/TS one of PLX-JS, and ansible, ansible-lint and actionlint for the ops artifacts, which mise installs beside node; the contract verbs compose both.
- The packages are versioned by the train and not by changesets (a deviation from § 5 PLX-Delivery, decided in § 1.6 PLX): `plx ship` writes their versions, and `release.yml` publishes them from the train's immutable GitHub release.
