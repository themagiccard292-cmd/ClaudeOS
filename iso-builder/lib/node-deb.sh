#!/usr/bin/env bash
# node-deb.sh TARBALL VERSION OUTDIR
# Repackage an official (already SHA256-verified) nodejs.org linux-x64 tarball as the deb
# `claudeos-nodejs`, which Provides/Conflicts/Replaces nodejs + npm. Used only when the Ubuntu archive's
# nodejs is older than Claude Code's minimum (node >= 22). Layout:
#   /opt/claudeos/node/{bin,lib,include,share}    the tarball contents
#   /opt/claudeos/node/etc/npmrc                  prefix=/usr/local (npm -g installs land in /usr/local
#                                                 exactly like with Ubuntu's own npm package)
#   /usr/bin/{node,npm,npx,corepack}              symlinks
set -euo pipefail

tarball="${1:?usage: node-deb.sh TARBALL VERSION OUTDIR}"
version="${2:?version required}"
outdir="${3:?outdir required}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=iso-builder/lib/common.sh
source "$here/common.sh"
# shellcheck source=iso-builder/lib/deb.sh
source "$here/deb.sh"

stage="$(mktemp -d)"
trap 'rm -rf -- "$stage"' EXIT

mkdir -p "$stage/opt/claudeos/node" "$stage/usr/bin"
tar -xJf "$tarball" -C "$stage/opt/claudeos/node" --strip-components=1 --no-same-owner
mkdir -p "$stage/opt/claudeos/node/etc"
printf 'prefix=/usr/local\n' >"$stage/opt/claudeos/node/etc/npmrc"
for b in node npm npx corepack; do
  if [[ -e "$stage/opt/claudeos/node/bin/$b" ]]; then
    ln -s "/opt/claudeos/node/bin/$b" "$stage/usr/bin/$b"
  fi
done

npm_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' \
  "$stage/opt/claudeos/node/lib/node_modules/npm/package.json")"

PKG_NAME=claudeos-nodejs
PKG_VERSION="${version}-1claudeos"
PKG_ARCH=amd64
PKG_DEPENDS="libc6, libstdc++6"
PKG_RECOMMENDS=""
PKG_SECTION=javascript
PKG_PROVIDES="nodejs (= ${version}), npm (= ${npm_version})"
PKG_CONFLICTS="nodejs, npm"
PKG_REPLACES="nodejs, npm"
PKG_DESCRIPTION="Node.js ${version} runtime (official nodejs.org build) for ClaudeOS
Repackaged, unmodified official Node.js binary distribution, installed under
/opt/claudeos/node. Only used when the Ubuntu archive's nodejs is older than
the version Claude Code requires."
write_control "$stage"
normalize_tree "$stage" "${SOURCE_DATE_EPOCH:-$(date +%s)}"
deb="$(build_deb "$stage" "$outdir")"
lint_deb "$deb"
echo "node-deb.sh: built $deb" >&2
