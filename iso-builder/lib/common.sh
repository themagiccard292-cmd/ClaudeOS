# shellcheck shell=bash
# Common helpers for the ClaudeOS ISO pipeline: logging, dry-run aware command execution,
# stamp files, mount tracking and the guarded recursive delete.
#
# Globals used (set by scripts/build-iso.sh or by tests):
#   DRY_RUN=0|1    print commands instead of running them
#   WORK_DIR       absolute path of the build work dir (everything we delete must live below it)

: "${DRY_RUN:=0}"
# Mount points registered with track_mount, in mount order (cleanup walks it backwards).
CLAUDEOS_MOUNTS=()

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log_info() { printf '[%s] %s\n' "$(ts)" "$*" >&2; }
log_warn() { printf '[%s] WARNING: %s\n' "$(ts)" "$*" >&2; }
die() {
  printf '[%s] ERROR: %s\n' "$(ts)" "$*" >&2
  exit 1
}

banner() {
  local line="=================================================================="
  printf '\n%s\n[%s] %s\n%s\n' "$line" "$(ts)" "$*" "$line" >&2
}

is_dry_run() { [[ "${DRY_RUN}" == 1 ]]; }

# Shell-quote a command line for display.
quote_cmd() {
  local out="" arg
  for arg in "$@"; do
    out+="$(printf '%q' "$arg") "
  done
  printf '%s' "${out% }"
}

# run CMD...: execute, or in dry-run mode print "+ CMD" (quoted) to stdout and do nothing.
run() {
  if is_dry_run; then
    printf '+ %s\n' "$(quote_cmd "$@")"
    return 0
  fi
  "$@"
}

# run_to FILE CMD...: like run, with stdout redirected to FILE.
run_to() {
  local file="$1"
  shift
  if is_dry_run; then
    printf '+ %s > %s\n' "$(quote_cmd "$@")" "$(printf '%q' "$file")"
    return 0
  fi
  "$@" >"$file"
}

# dry_note TEXT: in dry-run mode describe a data-dependent step that cannot be printed as one command.
dry_note() {
  if is_dry_run; then
    printf '+ # %s\n' "$*"
  fi
}

require_tools() {
  local missing=() t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  if ((${#missing[@]})); then
    printf '%s\n' "${missing[@]}"
    return 1
  fi
}

# ---------------------------------------------------------------- stamps (resumable stages)
stamp_dir() { printf '%s/.stamps' "$WORK_DIR"; }
stamp_done() { [[ -f "$(stamp_dir)/$1.done" ]]; }
stamp_set() {
  is_dry_run && return 0
  mkdir -p "$(stamp_dir)"
  date -u +%s >"$(stamp_dir)/$1.done"
}

# run_stage NUMBER NAME FUNCTION: banner + skip-if-stamped + stamp on success.
run_stage() {
  local num="$1" name="$2" fn="$3"
  banner "Stage ${num}: ${name}"
  if ! is_dry_run && stamp_done "$name"; then
    log_info "stage '${name}' already completed (stamp $(stamp_dir)/${name}.done) - skipping"
    return 0
  fi
  local start=$SECONDS
  "$fn"
  stamp_set "$name"
  log_info "stage '${name}' finished in $((SECONDS - start))s"
}

# ---------------------------------------------------------------- path safety

# path_is_under BASE PATH: true when PATH (resolved, need not exist) is BASE or lies below it.
path_is_under() {
  local base path
  base="$(realpath -m -- "$1")"
  path="$(realpath -m -- "$2")"
  [[ "$path" == "$base" || "$path" == "$base"/* ]]
}

# Prints every mount point at or below PATH (from /proc/self/mounts; octal escapes decoded).
mounts_under() {
  local path
  path="$(realpath -m -- "$1")"
  [[ -r /proc/self/mounts ]] || return 0
  awk -v p="$path" '
    function unesc(s) { gsub(/\\040/, " ", s); gsub(/\\011/, "\t", s); gsub(/\\012/, "\n", s); gsub(/\\134/, "\\", s); return s }
    { m = unesc($2); if (m == p || index(m, p "/") == 1) print m }
  ' /proc/self/mounts
}

# safe_rm_rf BASE PATH: rm -rf PATH, but only after proving that
#   * neither argument is empty, BASE is not "/" or $HOME or a top-level system directory,
#   * PATH resolves to BASE or below it (symlinks resolved), and is not "/" or $HOME,
#   * nothing is still mounted at or below PATH (a leftover bind of /dev or /proc would be fatal).
# Uses --one-file-system as a last line of defence.
safe_rm_rf() {
  local base="${1:-}" path="${2:-}"
  if [[ -z "$base" || -z "$path" ]]; then
    log_warn "safe_rm_rf: refusing empty path (base='${base}', path='${path}')"
    return 1
  fi
  local rbase rpath rhome
  rbase="$(realpath -m -- "$base")"
  rpath="$(realpath -m -- "$path")"
  rhome="$(realpath -m -- "${HOME:-/root}")"
  case "$rbase" in
    / | /bin | /boot | /dev | /etc | /home | /lib | /lib64 | /mnt | /opt | /proc | /root | /run | /sbin | /srv | /sys | /tmp | /usr | /var)
      log_warn "safe_rm_rf: refusing system directory as base: ${rbase}"
      return 1
      ;;
  esac
  if [[ "$rpath" == "/" || "$rpath" == "$rhome" || "$rbase" == "$rhome" ]]; then
    log_warn "safe_rm_rf: refusing to delete ${rpath}"
    return 1
  fi
  if ! path_is_under "$rbase" "$rpath"; then
    log_warn "safe_rm_rf: ${rpath} is not under ${rbase} - refusing"
    return 1
  fi
  local mounted
  mounted="$(mounts_under "$rpath")"
  if [[ -n "$mounted" ]]; then
    log_warn "safe_rm_rf: refusing to delete ${rpath}: still mounted below it: ${mounted//$'\n'/, }"
    return 1
  fi
  if is_dry_run; then
    printf '+ rm -rf --one-file-system %s\n' "$(printf '%q' "$rpath")"
    return 0
  fi
  rm -rf --one-file-system -- "$rpath"
}

# ---------------------------------------------------------------- mount tracking

track_mount() { CLAUDEOS_MOUNTS+=("$1"); }

# mount_tracked MOUNTPOINT MOUNT-ARGS...: mount (via run) and remember MOUNTPOINT for cleanup.
mount_tracked() {
  local mp="$1"
  shift
  run mount "$@" "$mp"
  is_dry_run || track_mount "$mp"
}

# Unmount one path, falling back to a lazy unmount if it is busy.
unmount_one() {
  local mp="$1"
  if ! mountpoint -q -- "$mp" 2>/dev/null; then
    return 0
  fi
  if ! umount -- "$mp" 2>/dev/null; then
    log_warn "umount ${mp} failed (busy?); retrying lazily"
    umount -l -- "$mp" || return 1
  fi
}

# Unmount everything we mounted (reverse order), then sweep anything else still mounted below
# WORK_DIR (deepest first) so a crash between mount and track_mount cannot leak a mount.
unmount_all() {
  local i rc=0
  for ((i = ${#CLAUDEOS_MOUNTS[@]} - 1; i >= 0; i--)); do
    unmount_one "${CLAUDEOS_MOUNTS[$i]}" || rc=1
  done
  CLAUDEOS_MOUNTS=()
  if [[ -n "${WORK_DIR:-}" ]]; then
    local mp
    while IFS= read -r mp; do
      [[ -n "$mp" ]] && { unmount_one "$mp" || rc=1; }
    done < <(mounts_under "$WORK_DIR" | awk '{ print length($0) "\t" $0 }' | sort -rn | cut -f2-)
  fi
  return "$rc"
}
