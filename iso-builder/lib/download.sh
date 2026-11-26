# shellcheck shell=bash
# Stage 2 helpers: upstream file names, download, SHA256 + GPG verification.

iso_filename() { printf 'ubuntu-%s-desktop-%s.iso\n' "$1" "${ISO_ARCH:-amd64}"; }
iso_url() { printf '%s/%s/%s\n' "${UBUNTU_RELEASES_URL:-https://releases.ubuntu.com}" "$1" "$(iso_filename "$1")"; }
sums_url() { printf '%s/%s/%s\n' "${UBUNTU_RELEASES_URL:-https://releases.ubuntu.com}" "$1" "${2:-SHA256SUMS}"; }
output_iso_name() { printf 'claudeos-%s-%s.iso\n' "$1" "${ISO_ARCH:-amd64}"; }
volume_id() { printf '%s %s %s\n' "${PRODUCT_NAME:-ClaudeOS}" "$1" "${ISO_ARCH:-amd64}"; }

# parse_sha256sums FILE NAME: print the hash listed for NAME (accepts "hash *name" and "hash  name").
parse_sha256sums() {
  awk -v n="$2" '
    NF >= 2 { f = $2; sub(/^\*/, "", f); if (f == n && length($1) == 64 && $1 ~ /^[0-9a-fA-F]+$/) { print tolower($1); found = 1; exit } }
    END { if (!found) exit 1 }
  ' "$1"
}

# resolve_expected_sha256 FETCHED PINNED ALLOW_UNPINNED: decide which hash the ISO must match.
# Either value may be empty. Prints the hash or fails with a reason on stderr.
resolve_expected_sha256() {
  local fetched="${1,,}" pinned="${2,,}" allow="${3:-0}"
  if [[ -n "$fetched" && -n "$pinned" ]]; then
    if [[ "$fetched" == "$pinned" ]]; then
      printf '%s\n' "$pinned"
      return 0
    fi
    if [[ "$allow" == 1 ]]; then
      log_warn "SHA256SUMS (${fetched}) disagrees with the pinned hash (${pinned}); ALLOW_UNPINNED=1 -> trusting the GPG-verified SHA256SUMS"
      printf '%s\n' "$fetched"
      return 0
    fi
    log_warn "SHA256SUMS lists ${fetched} but the pinned hash is ${pinned}. Refusing (set ALLOW_UNPINNED=1 to override)."
    return 1
  fi
  if [[ -n "$pinned" ]]; then
    printf '%s\n' "$pinned"
    return 0
  fi
  if [[ -n "$fetched" ]]; then
    if [[ "$allow" == 1 ]]; then
      printf '%s\n' "$fetched"
      return 0
    fi
    log_warn "no pinned SHA256 for this version; set ALLOW_UNPINNED=1 to trust SHA256SUMS alone"
    return 1
  fi
  log_warn "no expected SHA256 available (no SHA256SUMS entry and no pin)"
  return 1
}

# verify_sha256 FILE EXPECTED
verify_sha256() {
  local actual
  actual="$(sha256sum -- "$1" | awk '{ print $1 }')"
  if [[ "$actual" != "${2,,}" ]]; then
    log_warn "SHA256 mismatch for $1: expected ${2,,}, got ${actual}"
    return 1
  fi
  log_info "SHA256 OK: $1 (${actual})"
}

fetch() {
  local url="$1" dest="$2"
  run curl --fail --location --retry 5 --retry-delay 5 -C - --output "$dest" "$url"
}

# build_keyring OUT KEYFILE...: dearmor/concatenate armored keys into a gpgv keyring.
build_keyring() {
  local out="$1"
  shift
  : >"$out"
  local k
  for k in "$@"; do
    gpg --batch --quiet --dearmor <"$k" >>"$out"
  done
}

# gpg_verify_sums SUMS SIG KEYRING FPRS: verify the detached signature with gpgv and require that the
# signing primary key's fingerprint is one of FPRS (space separated).
gpg_verify_sums() {
  local sums="$1" sig="$2" keyring="$3" fprs="$4" status
  if ! status="$(gpgv --status-fd 1 --keyring "$keyring" "$sig" "$sums" 2>/dev/null)"; then
    log_warn "gpgv rejected the signature on ${sums}"
    return 1
  fi
  check_validsig "$status" "$fprs"
}

# check_validsig STATUS FPRS: pure check of gpg --status-fd output. VALIDSIG's last field is the primary key fpr.
check_validsig() {
  local status="$1" fprs="${2^^}" line primary f
  while IFS= read -r line; do
    [[ "$line" == "[GNUPG:] VALIDSIG "* ]] || continue
    primary="${line##* }"
    for f in $fprs; do
      if [[ "${primary^^}" == "$f" ]]; then
        log_info "GPG signature OK (primary key ${primary})"
        return 0
      fi
    done
    log_warn "valid signature, but by unexpected key ${primary}"
    return 1
  done <<<"$status"
  log_warn "no VALIDSIG in gpg status output"
  return 1
}
