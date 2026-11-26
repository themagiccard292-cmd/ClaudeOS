#!/usr/bin/env bash
# Write Packages + Packages.gz for a flat apt repository (a directory of .deb files), usable as
#   deb [trusted=yes] file:/path/to/dir ./
# Tool preference: dpkg-scanpackages (dpkg-dev) > apt-ftparchive (apt-utils) > lib/scan_packages.py.
# Set REPO_INDEXER=dpkg-scanpackages|apt-ftparchive|python to force one (used by the tests).
set -euo pipefail

repo="${1:?usage: repo-index.sh DIR}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

indexer="${REPO_INDEXER:-}"
if [[ -z "$indexer" ]]; then
  if command -v dpkg-scanpackages >/dev/null 2>&1; then
    indexer=dpkg-scanpackages
  elif command -v apt-ftparchive >/dev/null 2>&1; then
    indexer=apt-ftparchive
  else
    indexer=python
  fi
fi

cd "$repo"
case "$indexer" in
  dpkg-scanpackages) dpkg-scanpackages --multiversion . /dev/null 2>/dev/null >Packages ;;
  apt-ftparchive) apt-ftparchive packages . >Packages ;;
  python) python3 "$here/scan_packages.py" . >Packages ;;
  *)
    echo "repo-index.sh: unknown REPO_INDEXER '$indexer'" >&2
    exit 2
    ;;
esac
gzip -9nc Packages >Packages.gz
echo "repo-index.sh: indexed $(grep -c '^Package:' Packages) package(s) in $repo with $indexer" >&2
