#!/usr/bin/env bash
# Download the FULL ClaudeOS ISO (one file) and verify its SHA256.
#
# Sources:
#   ghcr      (default) single file from ghcr.io, pushed by the build workflow. Needs only curl + jq.
#                       Anonymous when the package is public; otherwise pass GH_TOKEN (read:packages).
#   artifact  the workflow-run artifact via the GitHub CLI (`gh`), needs a login; expires after 7 days.
#   release   the split release parts, joined by scripts/join-iso.sh.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: download-iso.sh [--source ghcr|artifact|release] [--repo OWNER/REPO] [--version 26.04.1]
                       [--tag TAG] [--run-id ID] [--out DIR]

  --source   where to fetch from (default: ghcr)
  --repo     GitHub repository (default: derived from `git remote origin`)
  --version  ISO version (default: 26.04.1); ghcr tag and file name
  --tag      release tag for --source release (default: latest release)
  --run-id   workflow run id for --source artifact
  --out      destination directory (default: .)
Environment: GH_TOKEN (optional) bearer token for private ghcr packages.
EOF
}

die() { echo "download-iso: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

source_kind=ghcr repo="" version="26.04.1" tag="" run_id="" out="."
while [ $# -gt 0 ]; do
  case "$1" in
    --source) source_kind="${2:?--source needs a value}"; shift 2 ;;
    --repo) repo="${2:?--repo needs a value}"; shift 2 ;;
    --version) version="${2:?--version needs a value}"; shift 2 ;;
    --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
    --run-id) run_id="${2:?--run-id needs a value}"; shift 2 ;;
    --out) out="${2:?--out needs a value}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

case "$version" in *[!0-9.]*) die "invalid --version: $version" ;; esac
iso="claudeos-${version}-amd64.iso"

if [ -z "$repo" ]; then
  url="$(git config --get remote.origin.url 2>/dev/null || true)"
  repo="$(printf '%s' "$url" | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')"
fi
case "$repo" in */*) ;; *) die "cannot determine repository; pass --repo OWNER/REPO" ;; esac
case "$repo" in *[!A-Za-z0-9._/-]*) die "invalid repository: $repo" ;; esac

mkdir -p "$out"

verify_sha() {
  local sumfile="$1"
  [ -f "$sumfile" ] || { echo "no checksum file; skipping verification" >&2; return 0; }
  (cd "$out" && sha256sum -c "$(basename "$sumfile")")
}

fetch_ghcr() {
  need curl
  need jq
  local image
  # ghcr image path: <owner>/claudeos-iso (the workflow pushes to ghcr.io/<owner>/claudeos-iso)
  image="$(printf '%s' "${repo%%/*}" | tr '[:upper:]' '[:lower:]')/claudeos-iso"
  local token_args=() token
  if [ -n "${GH_TOKEN:-}" ]; then
    token_args=(-u "token:${GH_TOKEN}")
  fi
  token="$(curl -fsS "${token_args[@]}" "https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull" | jq -r '.token')" \
    || die "could not get a ghcr.io token (is the package public, or is GH_TOKEN set?)"
  if [ -z "$token" ] || [ "$token" = null ]; then die "empty ghcr.io token"; fi

  local manifest
  manifest="$(curl -fsS -H "Authorization: Bearer ${token}" \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    "https://ghcr.io/v2/${image}/manifests/${version}")" \
    || die "manifest ghcr.io/${image}:${version} not found (not published yet, or package is private)"

  local digest sumdigest
  digest="$(jq -r --arg f "$iso" '.layers[] | select(.annotations["org.opencontainers.image.title"] == $f) | .digest' <<<"$manifest" | head -n1)"
  sumdigest="$(jq -r --arg f "$iso.sha256" '.layers[] | select(.annotations["org.opencontainers.image.title"] == $f) | .digest' <<<"$manifest" | head -n1)"
  [ -n "$digest" ] || die "manifest has no layer titled $iso"

  echo "Downloading $iso from ghcr.io/${image}:${version} (resumable; ctrl-C and re-run to continue)"
  curl -fL -C - --retry 5 --retry-all-errors -H "Authorization: Bearer ${token}" \
    -o "$out/$iso" "https://ghcr.io/v2/${image}/blobs/${digest}"
  if [ -n "$sumdigest" ]; then
    curl -fsSL -H "Authorization: Bearer ${token}" -o "$out/$iso.sha256" "https://ghcr.io/v2/${image}/blobs/${sumdigest}"
  fi
  local got
  got="sha256:$(sha256sum "$out/$iso" | cut -d' ' -f1)"
  [ "$got" = "$digest" ] || die "registry digest mismatch: expected $digest, got $got"
  verify_sha "$out/$iso.sha256"
}

fetch_artifact() {
  need gh
  [ -n "$run_id" ] || die "--run-id is required for --source artifact"
  gh run download "$run_id" --repo "$repo" --name claudeos-iso --dir "$out"
  verify_sha "$out/$iso.sha256"
}

fetch_release() {
  need gh
  local args=(--repo "$repo" --dir "$out" --pattern "${iso}.part-*" --pattern SHA256SUMS)
  if [ -n "$tag" ]; then gh release download "$tag" "${args[@]}"; else gh release download "${args[@]}"; fi
  bash "$(dirname "${BASH_SOURCE[0]}")/join-iso.sh" -o "$out/$iso" "$out"
}

case "$source_kind" in
  ghcr) fetch_ghcr ;;
  artifact) fetch_artifact ;;
  release) fetch_release ;;
  *) die "unknown --source: $source_kind" ;;
esac
echo "OK: $out/$iso"
