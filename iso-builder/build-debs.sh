#!/usr/bin/env bash
# Build one .deb per ClaudeOS module (every top-level directory with a package.meta) plus the
# meta package claudeos-desktop (iso-builder/package.meta), and index them as a flat apt repository.
#
#   iso-builder/build-debs.sh [--out DIR] [--only mod1,mod2] [--revision N] [--root DIR]
#
# Version = $(cat <root>/VERSION)+claudeos<N>. Reproducible: file mtimes are clamped to SOURCE_DATE_EPOCH
# (default: last git commit time) and dpkg-deb builds with --root-owner-group.
set -euo pipefail

ISO_BUILDER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=iso-builder/lib/common.sh
source "$ISO_BUILDER_DIR/lib/common.sh"
# shellcheck source=iso-builder/lib/deb.sh
source "$ISO_BUILDER_DIR/lib/deb.sh"

META_MODULE=iso-builder

usage() {
  cat <<'EOF'
Usage: build-debs.sh [--out DIR] [--only MODULE[,MODULE...]] [--revision N] [--root DIR]

  --out DIR        output directory (default: iso-builder/out/debs)
  --only LIST      build only these module directories (use "iso-builder" for the meta package)
  --revision N     package revision: version becomes <VERSION>+claudeos<N> (default: $CLAUDEOS_REVISION or 1)
  --root DIR       repository root holding VERSION and the module directories (default: this repo)
EOF
}

ROOT="$(cd "$ISO_BUILDER_DIR/.." && pwd)"
OUT=""
ONLY=""
REVISION="${CLAUDEOS_REVISION:-1}"
while (($#)); do
  case "$1" in
    --out | --only | --revision | --root)
      [[ $# -ge 2 ]] || die "$1 needs a value"
      case "$1" in
        --out) OUT="$2" ;;
        --only) ONLY="$2" ;;
        --revision) REVISION="$2" ;;
        --root) ROOT="$(cd "$2" && pwd)" ;;
      esac
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done
[[ "$REVISION" =~ ^[0-9]+$ ]] || die "--revision must be a number"
OUT="$(realpath -m -- "${OUT:-$ISO_BUILDER_DIR/out/debs}")"
[[ -f "$ROOT/VERSION" ]] || die "no VERSION file in $ROOT"
VERSION="$(tr -d '[:space:]' <"$ROOT/VERSION")"
PKG_VERSION_ALL="${VERSION}+claudeos${REVISION}"
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  SOURCE_DATE_EPOCH="$(git -C "$ROOT" log -1 --format=%ct 2>/dev/null || echo 1767225600)"
fi
export SOURCE_DATE_EPOCH

# Module directories with a package.meta, sorted; the meta package is handled separately.
discover_modules() {
  local f
  for f in "$ROOT"/*/package.meta; do
    [[ -f "$f" ]] || continue
    basename "$(dirname "$f")"
  done | LC_ALL=C sort | grep -vx "$META_MODULE" || true
}

wanted() {
  [[ -z "$ONLY" ]] && return 0
  [[ ",$ONLY," == *",$1,"* ]]
}

# load_meta MODULE: source package.meta into PKG_* (cleared first so values never leak between modules).
load_meta() {
  unset PKG_NAME PKG_DESCRIPTION PKG_DEPENDS PKG_RECOMMENDS PKG_ARCH PKG_SECTION PKG_PROVIDES PKG_CONFLICTS PKG_REPLACES
  # shellcheck source=/dev/null
  source "$ROOT/$1/package.meta"
  [[ -n "${PKG_NAME:-}" && -n "${PKG_DESCRIPTION:-}" ]] || die "$1/package.meta must set PKG_NAME and PKG_DESCRIPTION"
  [[ "$PKG_NAME" =~ ^[a-z0-9][a-z0-9+.-]+$ ]] || die "$1/package.meta: invalid PKG_NAME '$PKG_NAME'"
  case "${PKG_ARCH:=all}" in all | amd64) ;; *) die "$1/package.meta: PKG_ARCH must be all or amd64" ;; esac
  PKG_VERSION="$PKG_VERSION_ALL"
}

STAGE_ROOT=""
cleanup() { if [[ -n "$STAGE_ROOT" ]]; then rm -rf -- "$STAGE_ROOT"; fi; }
trap cleanup EXIT

# Packages the meta package only Recommends: the installer package pulls in calamares, which the
# installer purges from the installed system - a hard Depends would take claudeos-desktop with it.
META_SOFT_PACKAGES=" claudeos-calamares "

# build_module MODULE [EXTRA_DEPENDS [EXTRA_RECOMMENDS]]
build_module() {
  local module="$1" extra="${2:-}" extra_rec="${3:-}" stage s
  load_meta "$module"
  if [[ -n "$extra" ]]; then
    PKG_DEPENDS="${extra}${PKG_DEPENDS:+, $PKG_DEPENDS}"
  fi
  if [[ -n "$extra_rec" ]]; then
    PKG_RECOMMENDS="${extra_rec}${PKG_RECOMMENDS:+, $PKG_RECOMMENDS}"
  fi
  stage="$STAGE_ROOT/$module"
  mkdir -p "$stage"
  log_info "[$module] make install DESTDIR=$stage"
  make -s -C "$ROOT/$module" install DESTDIR="$stage" PREFIX=/usr SYSCONFDIR=/etc >&2 ||
    die "[$module] 'make install' failed"
  local bad
  if ! bad="$(check_stage_tree "$stage")"; then
    die "[$module] installs files outside the allowed prefixes (${DEB_ALLOWED_PREFIXES[*]}): ${bad//$'\n'/ }"
  fi
  write_control "$stage"
  for s in postinst prerm postrm; do
    if [[ -f "$ROOT/$module/debian/$s" ]]; then
      install -m 0755 "$ROOT/$module/debian/$s" "$stage/DEBIAN/$s"
    fi
  done
  normalize_tree "$stage" "$SOURCE_DATE_EPOCH"
  local deb
  deb="$(build_deb "$stage" "$OUT")"
  lint_deb "$deb" || die "[$module] lint failed for $deb"
  log_info "[$module] built $(basename "$deb")"
  BUILT+=("$deb")
}

main() {
  mkdir -p "$OUT"
  # Never mix packages from an earlier run (or another version) into the repository index.
  find "$OUT" -maxdepth 1 \( -name '*.deb' -o -name 'Packages' -o -name 'Packages.gz' \) -delete
  STAGE_ROOT="$(mktemp -d)"
  # Staged trees must not inherit a restrictive umask: dpkg requires sane DEBIAN/ permissions.
  umask 022
  BUILT=()

  local modules=() m names=() soft=()
  mapfile -t modules < <(discover_modules)
  for m in "${modules[@]}"; do
    load_meta "$m"
    if [[ "$META_SOFT_PACKAGES" == *" ${PKG_NAME} "* ]]; then
      soft+=("${PKG_NAME} (= ${PKG_VERSION_ALL})")
    else
      names+=("${PKG_NAME} (= ${PKG_VERSION_ALL})")
    fi
  done
  for m in "${modules[@]}"; do
    wanted "$m" && build_module "$m"
  done

  if [[ -f "$ROOT/$META_MODULE/package.meta" ]] && wanted "$META_MODULE"; then
    if ((${#names[@]} == 0)); then
      log_warn "no module has a package.meta yet; claudeos-desktop only depends on the archive packages"
    fi
    local joined=""
    for m in "${names[@]}"; do joined+="${joined:+, }$m"; done
    local joined_soft=""
    for m in "${soft[@]}"; do joined_soft+="${joined_soft:+, }$m"; done
    build_module "$META_MODULE" "$joined" "$joined_soft"
  fi
  ((${#BUILT[@]})) || die "nothing was built (check --only / package.meta files)"
  bash "$ISO_BUILDER_DIR/lib/repo-index.sh" "$OUT"
  log_info "built ${#BUILT[@]} package(s) into $OUT"
}

main
