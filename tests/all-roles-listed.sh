#!/usr/bin/env bash
# Fails when a role under ansible/roles is not listed in tests/all-roles.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

missing=0
for dir in ansible/roles/*/; do
  role=$(basename "$dir")
  if ! grep -qx "    - $role" tests/all-roles.yml; then
    echo "✗ role $role is not listed in tests/all-roles.yml" >&2
    missing=1
  fi
done
exit "$missing"
