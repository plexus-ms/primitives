#!/usr/bin/env bash
# Fills .ansible/collections, the project-local collections path ansible-lint
# and the syntax checks read and the only one they are given (mise.toml), so
# that a plexus.* collection installed user-wide (a tenant's pin) never shadows
# the checkout. Two steps, both idempotent; .ansible/ is ignored by git.
#
# 1. The four plexus.* collections are linked from ansible/.
# 2. The collections they depend on are installed from Galaxy: whatever the
#    `dependencies` of the four galaxy.yml files name, in the ranges they name.
#    The galaxy.yml files are the one list; none is kept here. A dependency
#    whose directory is there already is left alone, so the check needs the
#    network once per checkout and not on every commit; remove .ansible/ to
#    take newer releases.
set -euo pipefail
cd "$(dirname "$0")/.."
root=.ansible/collections/ansible_collections
mkdir -p "$root/plexus"
for dir in ansible/*/; do
  name=$(basename "$dir")
  ln -sfn "../../../../ansible/$name" "$root/plexus/$name"
done

# The entries under `dependencies:` as "namespace.name:range", once each.
dependencies=$(awk '
  /^dependencies:/ { inside = 1; next }
  inside && /^[^[:space:]#]/ { inside = 0 }
  inside && /^[[:space:]]+[a-z0-9_]+\.[a-z0-9_]+:/ {
    line = $0; sub(/#.*/, "", line); gsub(/[[:space:]"\047]/, "", line); print line
  }' ansible/*/galaxy.yml | sort -u)
missing=()
for dep in $dependencies; do
  name=${dep%%:*}
  [ -d "$root/${name%%.*}/${name#*.}" ] || missing+=("$dep")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "link-collections: installing ${missing[*]} into .ansible/collections"
  # --force: ansible-galaxy counts the collections bundled with the `ansible`
  # package it runs from as installed and would do nothing, but ansible-lint
  # runs from an environment of its own, with ansible-core alone, and sees
  # only this path.
  ansible-galaxy collection install --force --collections-path .ansible/collections "${missing[@]}"
fi
