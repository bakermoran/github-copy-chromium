#!/usr/bin/env bash
#
# Tests bin/gho's translation layer: which gh and git commands each Graphite-style
# verb turns into. GHO_DRY_RUN=1 makes bin/gho trace commands instead of running
# them, and GHO_STACK_JSON stands in for `gh stack view --json`, so no network,
# no GitHub, and no gh-stack state are involved.
#
# Usage: dev/gho.test.sh

set -uo pipefail

GHO="$(cd "$(dirname "$0")/.." && pwd)/bin/gho"
[ -x "$GHO" ] || { printf 'not executable: %s\n' "$GHO" >&2; exit 1; }

REPO="$(mktemp -d)"
trap 'rm -rf "$REPO"' EXIT

passed=0
failed=0

# A three-branch stack: main <- feat-a <- feat-b, with feat-b checked out.
setup_repo() {
  cd "$REPO"
  git init -q -b main .
  git config user.email t@example.com
  git config user.name Test
  printf 'root\n' >file.txt
  git add file.txt
  git commit -q -m "root"
  MAIN_SHA="$(git rev-parse HEAD)"

  git checkout -q -b feat-a
  printf 'a\n' >>file.txt
  git commit -q -am "commit a1"
  printf 'a2\n' >>file.txt
  git commit -q -am "commit a2"
  FEAT_A_SHA="$(git rev-parse HEAD)"

  git checkout -q -b feat-b
  printf 'b\n' >>file.txt
  git commit -q -am "commit b1"

  export GHO_STACK_JSON="{
    \"trunk\": \"main\",
    \"currentBranch\": \"feat-b\",
    \"branches\": [
      {\"name\": \"feat-a\", \"base\": \"$MAIN_SHA\", \"isCurrent\": false,
       \"isMerged\": false, \"isQueued\": false, \"needsRebase\": false},
      {\"name\": \"feat-b\", \"base\": \"$FEAT_A_SHA\", \"isCurrent\": true,
       \"isMerged\": false, \"isQueued\": false, \"needsRebase\": false}
    ]
  }"
  export GHO_DRY_RUN=1
  GIT_DIR_ABS="$(git rev-parse --absolute-git-dir)"
}

# The commands bin/gho would have run, one per line, without the "+ " prefix.
traced() {
  GHO_DRY_RUN=1 "$GHO" "$@" 2>&1 | sed -n 's/^+ //p'
}

# check <description> <expected-commands> -- <gho args...>
check() {
  local desc="$1" want="$2"; shift 2
  [ "${1:-}" = "--" ] && shift
  local got
  got="$(traced "$@")"
  if [ "$got" = "$want" ]; then
    passed=$((passed + 1))
    printf 'ok   %s\n' "$desc"
  else
    failed=$((failed + 1))
    printf 'FAIL %s\n' "$desc"
    printf '     want: %s\n' "$(printf '%s' "$want" | tr '\n' '|')"
    printf '     got:  %s\n' "$(printf '%s' "$got" | tr '\n' '|')"
  fi
}

# check_fails <description> <expected-substring-of-stderr> -- <gho args...>
check_fails() {
  local desc="$1" needle="$2"; shift 2
  [ "${1:-}" = "--" ] && shift
  local out status
  out="$(GHO_DRY_RUN=1 "$GHO" "$@" 2>&1)"
  status=$?
  if [ "$status" != 0 ] && printf '%s' "$out" | grep -qF "$needle"; then
    passed=$((passed + 1))
    printf 'ok   %s\n' "$desc"
  else
    failed=$((failed + 1))
    printf 'FAIL %s (exit %s)\n' "$desc" "$status"
    printf '     want stderr to contain: %s\n' "$needle"
    printf '     got: %s\n' "$out"
  fi
}

setup_repo

printf '\n# passthrough\n'
check "unknown commands go to gh" \
  "gh pr list --limit 3" -- pr list --limit 3
check "gh's own stack verbs pass through" \
  "gh stack view" -- stack view
check "gh stack push passes through" \
  "gh stack push --remote upstream" -- stack push --remote upstream

printf '\n# sync\n'
check "sync is gh stack rebase" \
  "gh stack rebase" -- stack sync
check "sync --no-restack only fetches" \
  "git fetch --prune" -- stack sync --no-restack
check "sync --delete-all uses gh's own sync" \
  "gh stack sync --prune" -- stack sync --delete-all
check "sync -d is --delete-all" \
  "gh stack sync --prune" -- stack sync -d
check "sync passes --remote through" \
  "gh stack rebase --remote upstream" -- stack sync --remote upstream
check "sync --continue forwards to rebase" \
  "gh stack rebase --continue" -- stack sync --continue
check "sync -f is accepted" \
  "gh stack rebase" -- stack sync -f
check_fails "sync -a is rejected" "every configured trunk" -- stack sync -a

printf '\n# modify\n'
check "modify amends then rebases" \
  "git commit --amend --no-edit
gh stack rebase --upstack --no-trunk" -- stack modify
check "m is modify" \
  "git commit --amend --no-edit
gh stack rebase --upstack --no-trunk" -- stack m
check "modify -am stages and amends with a message" \
  "git add -A
git commit --amend -m 'new message'
gh stack rebase --upstack --no-trunk" -- stack m -am "new message"
check "modify -c makes a new commit" \
  "git commit -m added
gh stack rebase --upstack --no-trunk" -- stack modify -c -m added
check "modify -cam clusters" \
  "git add -A
git commit -m added
gh stack rebase --upstack --no-trunk" -- stack m -cam added
check "modify -u stages tracked files only" \
  "git add -u
git commit --amend --no-edit
gh stack rebase --upstack --no-trunk" -- stack modify -u
check "modify -e opens an editor" \
  "git commit --amend --edit
gh stack rebase --upstack --no-trunk" -- stack modify -e
check "modify --reset-author" \
  "git commit --amend --reset-author --no-edit
gh stack rebase --upstack --no-trunk" -- stack modify --reset-author
check "modify --no-verify skips hooks" \
  "git commit --no-verify --amend --no-edit
gh stack rebase --upstack --no-trunk" -- stack modify --no-verify
# Graphite's modify restacks descendants only, so --upstack --no-trunk is the
# default; a scoping flag replaces it rather than adding to it.
check "modify restacks descendants only by default" \
  "git commit --amend --no-edit
gh stack rebase --upstack --no-trunk" -- stack modify
check "a scoping flag replaces modify's default scope" \
  "git commit --amend --no-edit
gh stack rebase --downstack" -- stack modify --downstack
check "modify --abort reaches gh's stack editor" \
  "gh stack modify --abort" -- stack modify --abort
check "modify --into moves staged work downstack" \
  "git stash push --staged -m 'gho stack modify --into feat-a'
gh stack checkout feat-a
git stash pop --index
git commit --amend --no-edit
gh stack rebase --upstack --no-trunk
gh stack checkout feat-b" -- stack modify --into feat-a
check_fails "modify --into rejects an upstack target" "is not below" \
  -- stack modify --into feat-b

printf '\n# create\n'
check "create adds a branch then commits" \
  "gh stack add feat-c
git add -A
git commit -m 'third layer'" -- stack create feat-c -am "third layer"
check "c is create" \
  "gh stack add feat-c
git commit -m x" -- stack c feat-c -m x
# With no -m, git commit opens an editor, which is what `gt create` does too.
check "create -o checks out the parent first" \
  "gh stack checkout feat-a
gh stack add feat-c
git commit" -- stack create feat-c --onto feat-a
check "create without a name lets gh name it" \
  "gh stack add -m 'fix the login bug' -A" -- stack create -am "fix the login bug"
check "create joins repeated -m like git" \
  "gh stack add feat-c
git commit -m subject -m body" -- stack create feat-c -m subject -m body
check_fails "create -i is rejected" "restructure" -- stack create feat-c -i

printf '\n# restack\n'
check "restack leaves trunk alone" \
  "gh stack rebase --no-trunk" -- stack restack
check "r is restack" \
  "gh stack rebase --no-trunk" -- stack r
check "restack --downstack" \
  "gh stack rebase --downstack --no-trunk" -- stack restack --downstack
check "restack --upstack" \
  "gh stack rebase --upstack --no-trunk" -- stack restack -u
check "restack --only rebases onto the parent" \
  "git rebase --onto feat-a $FEAT_A_SHA feat-b" -- stack restack --only
check "restack --branch returns to where you were" \
  "gh stack checkout feat-a
gh stack rebase --no-trunk
gh stack checkout feat-b" -- stack restack --branch feat-a

printf '\n# submit\n'
check "submit is gh stack submit" \
  "gh stack submit --auto" -- stack submit
check "submit -d drafts new PRs" \
  "gh stack submit --auto" -- stack submit -d
check "submit -p publishes" \
  "gh stack submit --open --auto" -- stack submit -p
check "submit --restack rebases first" \
  "gh stack rebase --no-trunk
gh stack submit --auto" -- stack submit --restack
check "submit -u only pushes branches" \
  "gh stack push" -- stack submit -u
check "submit --remote" \
  "gh stack submit --auto --remote upstream" -- stack submit --remote upstream
check "submit -r sets reviewers per branch" \
  "gh stack submit --auto
gh pr edit feat-a --add-reviewer alice,bob
gh pr edit feat-b --add-reviewer alice,bob" -- stack submit -r alice,bob
check "submit --comment comments afterwards" \
  "gh stack submit --auto
gh pr comment --body shipped" -- stack submit --comment shipped
check "submit -v opens the PR" \
  "gh stack submit --auto
gh pr view --web" -- stack submit -v
check "submit --dry-run runs nothing" \
  "gh stack submit --auto" -- stack submit --dry-run
check_fails "submit --ai is rejected" "no gh stack equivalent" -- stack submit --ai
check_fails "submit --no-stack is rejected" "cannot narrow" -- stack submit --no-stack
check_fails "submit -m is rejected with a pointer" "gho stack merge" -- stack submit -m

printf '\n# navigation and logs\n'
check "log is gh stack view" \
  "gh stack view" -- stack log
check "ls is the short view" \
  "gh stack view --short" -- stack ls
check "log short is the short view" \
  "gh stack view --short" -- stack log short
check "ll graphs the stack's commits" \
  "git log --graph --oneline --decorate main..HEAD" -- stack ll
check "log --json passes through" \
  "gh stack view --json" -- stack log --json
check "up moves one branch" \
  "gh stack up" -- stack up
check "up takes a count" \
  "gh stack up 2" -- stack up 2
check "u -n takes a count" \
  "gh stack up 3" -- stack u -n 3
check "down takes a count" \
  "gh stack down 2" -- stack d 2
check "top and bottom" \
  "gh stack top" -- stack t
check "checkout with a branch" \
  "gh stack checkout feat-a" -- stack co feat-a
check "checkout without one picks interactively" \
  "gh stack switch" -- stack checkout
check "checkout -t goes to trunk" \
  "gh stack trunk" -- stack co -t
check_fails "log -a is rejected" "every configured trunk" -- stack log -a

printf '\n# squash\n'
check "squash resets then recommits and restacks" \
  "git reset --soft $FEAT_A_SHA
git commit -m squashed
gh stack rebase --upstack --no-trunk" -- stack squash -m squashed
check "sq -n reuses the old messages" \
  "git reset --soft $FEAT_A_SHA
git commit --file $GIT_DIR_ABS/gho-squash-msg
gh stack rebase --upstack --no-trunk" -- stack sq -n

printf '\n# tracking\n'
check "track adopts branches" \
  "gh stack init feat-x" -- stack track feat-x
check "track -p sets the base" \
  "gh stack init --base main feat-x" -- stack tr feat-x -p main
check "untrack drops local tracking" \
  "gh stack unstack --local" -- stack untrack

printf '\n# get\n'
check "get fetches then restacks" \
  "gh stack checkout 42
gh stack rebase" -- stack get 42
check "get --no-restack" \
  "gh stack checkout 42" -- stack get 42 --no-restack
check "get --no-checkout comes back" \
  "gh stack checkout 42
gh stack rebase
gh stack checkout feat-b" -- stack get 42 --no-checkout

printf '\n# recovery\n'
check "continue resumes the rebase" \
  "gh stack rebase --continue" -- stack continue
check "continue -a stages first" \
  "git add -A
gh stack rebase --continue" -- stack continue -a
check "abort restores branches" \
  "gh stack rebase --abort" -- stack abort -f
check_fails "undo needs a snapshot" "no gho stack snapshot" -- stack undo

printf '\n# structural verbs\n'
check "restructure is gh's stack editor" \
  "gh stack modify" -- stack restructure
check "fold opens the stack editor" \
  "gh stack modify" -- stack fold
check "reorder opens the stack editor" \
  "gh stack modify" -- stack reorder
check_fails "absorb explains itself" "modify --into" -- stack absorb
check_fails "split explains itself" "rebase -i" -- stack split
check_fails "pop explains itself" "reset --soft" -- stack pop
check_fails "freeze explains itself" "no equivalent" -- stack freeze

printf '\n# global options\n'
check "--cwd is honored" \
  "gh stack rebase" -- stack sync --cwd "$REPO"
check "-q silences narration but not the trace" \
  "gh stack rebase" -- stack sync -q

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" = 0 ]
