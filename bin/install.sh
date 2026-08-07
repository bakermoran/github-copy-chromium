#!/usr/bin/env bash
#
# Installs the gho CLI: checks everything it depends on, offers to install what
# is missing, then links gho onto your PATH.
#
# Usage:
#   bin/install.sh                 check, prompt, and link into ~/.local/bin
#   bin/install.sh --dir <path>    link somewhere else
#   bin/install.sh --yes           install missing dependencies without asking
#   bin/install.sh --check         report only; install and link nothing
#   bin/install.sh --name <name>   install under a different command name

set -uo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/gho"
DIR="$HOME/.local/bin"
NAME="gho"
ASSUME_YES=0
CHECK_ONLY=0

GIT_MIN="2.35"

problems=0
installed=0

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_WARN=$'\033[33m'; C_STEP=$'\033[36m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_BAD=""; C_WARN=""; C_STEP=""; C_OFF=""
fi

ok()   { printf '  %sok%s       %-20s %s\n' "$C_OK" "$C_OFF" "$1" "${2:-}"; }
bad()  { printf '  %smissing%s  %-20s %s\n' "$C_BAD" "$C_OFF" "$1" "${2:-}"; problems=$((problems + 1)); }
warn() { printf '  %snote%s     %-20s %s\n' "$C_WARN" "$C_OFF" "$1" "${2:-}"; }
step() { printf '  %s→%s        %s\n' "$C_STEP" "$C_OFF" "$1"; }
die()  { printf '\ninstall.sh: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)    DIR="${2:-}"; [ -n "$DIR" ] || die "--dir needs a path"; shift 2 ;;
    --dir=*)  DIR="${1#*=}"; shift ;;
    --name)   NAME="${2:-}"; [ -n "$NAME" ] || die "--name needs a value"; shift 2 ;;
    --name=*) NAME="${1#*=}"; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --check)  CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)        die "unknown option '$1'" ;;
  esac
done

[ -f "$SRC" ] || die "cannot find the gho script next to this installer ($SRC)"

# Ask before changing the machine. --yes and non-interactive shells say yes and
# no respectively, so CI never hangs and never installs by surprise.
may_i() {
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ ! -t 0 ]; then return 1; fi
  local reply=""
  printf '           install it now? [y/N] '
  read -r reply || true
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

version_at_least() { # $1 = minimum x.y, $2 = actual
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$1" ]
}

printf '\nChecking what gho needs\n\n'

# --- bash --------------------------------------------------------------------
ok "bash" "${BASH_VERSION:-unknown}"

# --- git ---------------------------------------------------------------------
if command -v git >/dev/null 2>&1; then
  git_v="$(git version | awk '{print $3}')"
  if version_at_least "$GIT_MIN" "$git_v"; then
    ok "git" "$git_v"
  else
    bad "git" "$git_v — gho stack modify --into needs $GIT_MIN or newer"
    step "brew upgrade git"
  fi
else
  bad "git" "not on PATH"
  step "brew install git"
fi

# --- gh ----------------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  ok "gh" "$(gh --version | head -1 | awk '{print $3}')"
else
  bad "gh" "the GitHub CLI is what gho forwards to"
  if may_i; then
    if command -v brew >/dev/null 2>&1; then
      step "brew install gh"
      if brew install gh; then
        installed=$((installed + 1)); problems=$((problems - 1))
        ok "gh" "$(gh --version | head -1 | awk '{print $3}')"
      fi
    else
      step "no brew found — install gh from https://cli.github.com"
    fi
  else
    step "brew install gh"
  fi
fi

# --- gh auth -----------------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh auth" "logged in"
  else
    bad "gh auth" "gho cannot reach GitHub until you log in"
    step "gh auth login"
  fi
fi

# --- gh-stack extension ------------------------------------------------------
if command -v gh >/dev/null 2>&1; then
  if gh extension list 2>/dev/null | grep -q 'gh[[:space:]]*stack'; then
    ok "gh-stack extension" "$(gh stack --version 2>/dev/null | awk '{print $NF}')"
  else
    bad "gh-stack extension" "every gho stack verb is built on it"
    if may_i; then
      step "gh extension install github/gh-stack"
      if gh extension install github/gh-stack; then
        installed=$((installed + 1)); problems=$((problems - 1))
        ok "gh-stack extension" "$(gh stack --version 2>/dev/null | awk '{print $NF}')"
      fi
    else
      step "gh extension install github/gh-stack"
    fi
  fi
fi

# --- jq or python3 -----------------------------------------------------------
if command -v jq >/dev/null 2>&1; then
  ok "jq or python3" "jq $(jq --version | sed 's/^jq-//')"
elif command -v python3 >/dev/null 2>&1; then
  ok "jq or python3" "$(python3 --version)"
else
  bad "jq or python3" "needed to read gh stack view --json"
  if may_i && command -v brew >/dev/null 2>&1; then
    step "brew install jq"
    if brew install jq; then
      installed=$((installed + 1)); problems=$((problems - 1))
      ok "jq or python3" "jq $(jq --version | sed 's/^jq-//')"
    fi
  else
    step "brew install jq"
  fi
fi

if [ "$CHECK_ONLY" = 1 ]; then
  printf '\n'
  if [ "$problems" = 0 ]; then printf 'All dependencies present. Re-run without --check to link gho.\n'; exit 0; fi
  printf '%s missing. Re-run without --check to install them.\n' "$problems"
  exit 1
fi

if [ "$problems" != 0 ]; then
  printf '\n%s dependency problem(s) above. Fix them, then re-run.\n' "$problems"
  printf 'Nothing was linked.\n'
  exit 1
fi

# --- link onto PATH ----------------------------------------------------------
printf '\nInstalling %s\n\n' "$NAME"

TARGET="$DIR/$NAME"

# Never clobber an unrelated binary. This is the mistake `go` would have made.
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
  current="$(readlink "$TARGET" 2>/dev/null || true)"
  if [ "$current" = "$SRC" ]; then
    ok "$TARGET" "already linked here"
  else
    printf '  %srefusing%s %s already exists\n' "$C_BAD" "$C_OFF" "$TARGET"
    if [ -n "$current" ]; then
      printf '           it points at %s\n' "$current"
    else
      printf '           it is a real file, not our symlink\n'
    fi
    die "remove it yourself, or choose another name with --name"
  fi
else
  mkdir -p "$DIR" || die "cannot create $DIR"
  ln -s "$SRC" "$TARGET" || die "cannot link $TARGET"
  ok "$TARGET" "linked to $SRC"
fi

chmod +x "$SRC"

# Warn if something else on PATH would win, or if the directory is not on PATH.
case ":$PATH:" in
  *":$DIR:"*)
    found="$(command -v "$NAME" 2>/dev/null || true)"
    if [ "$found" = "$TARGET" ]; then
      ok "PATH" "$DIR is on your PATH"
    else
      warn "PATH" "$DIR is on your PATH, but '$NAME' resolves to $found"
      warn "" "an earlier PATH entry is shadowing the link"
    fi
    ;;
  *)
    warn "PATH" "$DIR is not on your PATH — add this to ~/.zshrc:"
    printf '           export PATH="%s:$PATH"\n' "$DIR"
    ;;
esac

printf '\n'
if [ "$installed" -gt 0 ]; then printf 'Installed %s missing dependency/ies.\n' "$installed"; fi
printf 'Done. Try:  %s stack --help\n' "$NAME"
printf 'Recheck any time with:  %s doctor\n' "$NAME"
