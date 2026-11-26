#!/usr/bin/env bash
# Reassemble a ClaudeOS ISO published as split release assets and verify its SHA256.
#
#   scripts/join-iso.sh [-o OUTPUT] DIR
#   scripts/join-iso.sh [-o OUTPUT] claudeos-26.04.1-amd64.iso.part-aa claudeos-26.04.1-amd64.iso.part-ab ...
#
# Parts are joined in name order (suffixes aa, ab, ... or 00, 01, ...). The expected hash is taken from
# OUTPUT.sha256 or a SHA256SUMS file next to the parts; without either the script fails unless
# --no-verify is given. Equivalent manual steps:  cat claudeos-*.iso.part-* > claudeos.iso && sha256sum -c ...
set -euo pipefail

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

out=""
verify=1
parts=()
while (($#)); do
  case "$1" in
    -o | --output)
      [[ $# -ge 2 ]] || { echo "join-iso: $1 needs a value" >&2; exit 2; }
      out="$2"
      shift 2
      ;;
    --no-verify) verify=0 && shift ;;
    -h | --help) usage && exit 0 ;;
    --) shift && parts+=("$@") && break ;;
    -*) echo "join-iso: unknown option $1" >&2 && exit 2 ;;
    *) parts+=("$1") && shift ;;
  esac
done
((${#parts[@]})) || { usage >&2; exit 2; }

if ((${#parts[@]} == 1)) && [[ -d "${parts[0]}" ]]; then
  dir="${parts[0]}"
  mapfile -t parts < <(find "$dir" -maxdepth 1 -type f -name '*.iso.part-*' | LC_ALL=C sort)
  ((${#parts[@]})) || { echo "join-iso: no *.iso.part-* files in $dir" >&2; exit 1; }
else
  mapfile -t parts < <(printf '%s\n' "${parts[@]}" | LC_ALL=C sort)
fi

# All parts must belong to the same ISO and use one suffix scheme.
base=""
for p in "${parts[@]}"; do
  [[ -f "$p" ]] || { echo "join-iso: no such file: $p" >&2; exit 1; }
  name="$(basename "$p")"
  [[ "$name" =~ ^(.+\.iso)\.part-([a-z]+|[0-9]+)$ ]] || { echo "join-iso: not an ISO part: $name" >&2; exit 1; }
  if [[ -z "$base" ]]; then
    base="${BASH_REMATCH[1]}"
  elif [[ "$base" != "${BASH_REMATCH[1]}" ]]; then
    echo "join-iso: parts of different images: $base vs ${BASH_REMATCH[1]}" >&2
    exit 1
  fi
done
partdir="$(dirname "${parts[0]}")"
out="${out:-$partdir/$base}"

expected=""
if ((verify)); then
  for sums in "$out.sha256" "$partdir/$base.sha256" "$partdir/SHA256SUMS"; do
    [[ -f "$sums" ]] || continue
    expected="$(awk -v n="$base" '{ f = $2; sub(/^\*/, "", f); if (f == n) { print tolower($1); exit } }' "$sums")"
    [[ -n "$expected" ]] && break
  done
  [[ -n "$expected" ]] || { echo "join-iso: no SHA256 for $base (need $base.sha256 or SHA256SUMS; --no-verify to skip)" >&2; exit 1; }
fi

tmp="$out.partial"
echo "join-iso: joining ${#parts[@]} part(s) into $out" >&2
cat -- "${parts[@]}" >"$tmp"
if ((verify)); then
  actual="$(sha256sum -- "$tmp" | awk '{ print $1 }')"
  if [[ "$actual" != "$expected" ]]; then
    rm -f -- "$tmp"
    echo "join-iso: SHA256 MISMATCH (expected $expected, got $actual) - a part is missing or corrupt" >&2
    exit 1
  fi
  echo "join-iso: SHA256 OK ($actual)" >&2
fi
mv -- "$tmp" "$out"
echo "$out"
