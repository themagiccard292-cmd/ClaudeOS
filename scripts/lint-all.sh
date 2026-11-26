#!/usr/bin/env bash
# Repository-wide static checks (run by `make lint` before the per-module linters):
#   1. shellcheck on every shell script (*.sh, or a sh/bash/dash shebang)
#   2. yamllint (root .yamllint) on every *.yml / *.yaml
#   3. jq empty on every *.json (tsconfig-style JSON-with-comments files are left to tsc)
#   4. python3 -m compileall smoke test on every *.py
#   5. the "no API key" guard (scripts/check_no_api_key.py)
# Files come from git (tracked + untracked-but-not-ignored), so node_modules/, .venv/, dist/, out/, work/
# are skipped through .gitignore; the explicit filter below also covers checkouts without git metadata.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Optional argument: the tree to check (default: this repository). Used by the tests.
ROOT="$(cd "${1:-$SCRIPT_DIR/..}" && pwd)"
cd "$ROOT"

SKIP_DIRS_RE='(^|/)(node_modules|\.venv|venv|dist|dist-package|work|out|build|cache|\.git|__pycache__|\.pytest_cache)/'
# Real-world fixtures captured verbatim from upstream artefacts are data, not our YAML/JSON style.
FIXTURE_RE='(^|/)tests/fixtures/'

list_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z --cached --others --exclude-standard | tr '\0' '\n'
  else
    find . -type f | sed 's|^\./||'
  fi | grep -Ev "$SKIP_DIRS_RE" | while IFS= read -r f; do [[ -f "$f" ]] && printf '%s\n' "$f"; done | LC_ALL=C sort
}

mapfile -t FILES < <(list_files)
failures=()

section() { printf '\n== %s\n' "$*"; }

is_shell() {
  case "$1" in
    *.sh | *.bash) return 0 ;;
    *.py | *.js | *.ts | *.tsx | *.json | *.md | *.yml | *.yaml | *.png | *.svg | *.qml) return 1 ;;
  esac
  local first
  first="$(head -c 128 -- "$1" 2>/dev/null | head -n1 | tr -d '\0')" || return 1
  [[ "$first" =~ ^#!.*(/|[[:space:]])(ba|da)?sh([[:space:]]|$) ]]
}

shell=() yaml=() json=() py=()
for f in "${FILES[@]}"; do
  case "$f" in
    *.yml | *.yaml) [[ "$f" =~ $FIXTURE_RE ]] || yaml+=("$f") ;;
    *.json)
      case "$(basename "$f")" in tsconfig*.json | jsconfig*.json) ;; *) [[ "$f" =~ $FIXTURE_RE ]] || json+=("$f") ;; esac
      ;;
    *.py) py+=("$f") ;;
  esac
  if is_shell "$f"; then shell+=("$f"); fi
done

section "shellcheck (${#shell[@]} files)"
if ((${#shell[@]})); then
  shellcheck -x --source-path="$ROOT" "${shell[@]}" || failures+=(shellcheck)
fi

section "yamllint (${#yaml[@]} files)"
if ((${#yaml[@]})); then
  yamllint -s -c .yamllint "${yaml[@]}" || failures+=(yamllint)
fi

section "jq empty (${#json[@]} files)"
for f in "${json[@]}"; do
  jq empty "$f" >/dev/null 2>&1 || {
    echo "invalid JSON: $f"
    failures+=("json:$f")
  }
done

section "python compileall (${#py[@]} files)"
if ((${#py[@]})); then
  pycache="$(mktemp -d)"
  PYTHONPYCACHEPREFIX="$pycache" python3 -m compileall -q "${py[@]}" >/dev/null || failures+=(compileall)
  rm -rf -- "$pycache"
fi

section "no-API-key guard"
python3 "$SCRIPT_DIR/check_no_api_key.py" --root "$ROOT" "${FILES[@]}" || failures+=(api-key-guard)

if ((${#failures[@]})); then
  printf '\nlint-all: FAILED: %s\n' "${failures[*]}" >&2
  exit 1
fi
printf '\nlint-all: OK\n'
