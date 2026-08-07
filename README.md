# GitHub PR Link Copier (Chromium)

A Chromium/Manifest V3 port of [justinpchang/github-pr-link-copy](https://github.com/justinpchang/github-pr-link-copy) for Brave, Chrome, Edge, and Arc. It copies GitHub pull requests as rich links with their line diff. In Slack and other rich-text editors, links paste as formatted text; plain-text editors receive Markdown:

```md
[#24 Add authentication layer `+18/-3`](https://github.com/example/repo/pull/24)
```

![Copy PR and stack controls in GitHub](docs/github-pr-link-copy.png)

Use **Copy PR link** for one PR. For GitHub Stacked PRs, open the stack map and use **Copy Stack** to copy a top-to-bottom bulleted list. Private repositories work without a personal access token.

## Shortcuts

| Keys | Action |
| --- | --- |
| <kbd>c</kbd> <kbd>l</kbd> | Copy the current PR's link |
| <kbd>c</kbd> <kbd>s</kbd> | Copy the stack |

Press the keys in sequence, like GitHub's own <kbd>g</kbd> <kbd>c</kbd> shortcuts; the second key has 1.5 seconds to land. They are ignored while a text field, textarea, or comment box has focus, and while any modifier is held — <kbd>⌘C</kbd> still copies text normally.

Because a keyboard copy can happen while the buttons are scrolled out of view, the result also appears as a brief toast in the corner. <kbd>c</kbd> <kbd>s</kbd> only works where the **Copy Stack** button is — open the stack first, or the toast will say so.

Note that this claims three keys on PR pages that GitHub itself uses: bare <kbd>l</kbd> (edit labels) and <kbd>s</kbd> (focus search) still work on their own, but not within 1.5 seconds of pressing <kbd>c</kbd>, and <kbd>c</kbd> is swallowed entirely.

## Install in Brave

1. Open `brave://extensions` (Chrome: `chrome://extensions`).
2. Turn on **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select this directory.
4. Reload any open GitHub PR tabs.

Unpacked extensions survive restarts, but Brave will show a "developer mode extensions" warning on each launch. To silence it, pack the extension (**Pack extension…** on the same page) and drag the resulting `.crx` onto `brave://extensions`.

## What changed from the Firefox version

- **Manifest V3.** `manifest_version: 3`, host access moved from `permissions` to `host_permissions`, and the Gecko-specific `browser_specific_settings` block is gone.
- **The diff fetch moved to a service worker** (`background.js`). `https://github.com/<owner>/<repo>/pull/<n>.diff` redirects to `patch-diff.githubusercontent.com`, which returns no CORS headers. MV2 content scripts could ignore CORS given host permissions; MV3 content scripts cannot, so the fetch runs in the extension's own network context and the text comes back over `chrome.runtime.sendMessage`. The worker only accepts canonical PR and `.diff` URLs (`core.isFetchablePrUrl`) so it can't be used as a general fetch proxy.
- **The PR page fetch stayed in the content script.** It is same-origin with github.com, so it keeps the user's session cookies — which is what makes private repos work without a token.
- **Titles come from GitHub's hovercard partial** (`/pull/<n>/hovercard`, ~4 KB) instead of the full PR page (~360 KB), roughly a third of the latency. It requires the `X-Requested-With: XMLHttpRequest` header, and the title is only trusted when the hovercard's own anchor points at the PR being fetched — GitHub answers that path with an *issue* hovercard when the number is an issue. Anything unexpected falls back to the full page fetch.
- **A stack's PRs are fetched concurrently**, and each PR's title and diff are fetched concurrently with each other. Both were serial upstream, which is what made **Copy Stack** take several seconds.
- **Keyboard shortcuts and the toast are new here** — upstream has neither. The chord is intercepted in the capture phase on `window`, which is the earliest point available and the only reliable way to beat GitHub's own `l` and `s` bindings to the key.
- Clipboard error messages no longer name Firefox. The behavior is unchanged: `navigator.clipboard.write()` first, falling back to a `contentEditable` selection plus `document.execCommand("copy")`, which is what makes the copy succeed when a slow diff fetch outlasts the click's user activation.

`content.css` and the button/stack detection logic are unchanged from upstream; `core.js` only gained `isFetchablePrUrl`.

## The `gho` CLI

`bin/gho` is a companion command-line tool for the same GitHub Stacked PRs this
extension copies links from — `gh` plus `o`, for Owner. It forwards everything
to `gh`, except for a `gho stack` namespace that gives
[`gh stack`](https://gh.io/stacks) the
[Graphite CLI](https://graphite.com/docs/cheatsheet)'s verbs, flags, and
aliases:

```sh
gho pr list                  # just gh
gho stack sync               # gh stack rebase
gho stack modify             # amend, then restack the branches above
gho stack m -am "fix typo"   # stage everything, amend, restack
gho stack c feat-api -m "…"  # gh stack add + git commit
gho stack ss                 # gh stack submit
gho stack ls                 # gh stack view --short
gho stack up 2 / co / t / b  # navigate the stack
```

### Install

```sh
bin/install.sh
```

The installer checks every dependency, offers to install the ones it can, and
then links `gho` into `~/.local/bin`. It refuses to overwrite an existing
binary of that name, and tells you if the directory is missing from your `PATH`
or if something earlier on `PATH` would shadow the link.

| flag | effect |
| --- | --- |
| `--check` | report only; install and link nothing |
| `--yes` | install missing dependencies without prompting |
| `--dir <path>` | link somewhere other than `~/.local/bin` |
| `--name <name>` | install under a different command name |

Dependencies are required, not optional — `gho stack` refuses to run without
them rather than failing halfway through an operation:

- **`gh`**, authenticated (`gh auth login`)
- **the `github/gh-stack` extension** (`gh extension install github/gh-stack`),
  which every stack verb is built on
- **git 2.35+**, for the `git stash push --staged` that `modify --into` uses
- **`jq` or `python3`**, to read `gh stack view --json`

`gho doctor` re-checks all of that at any time and names the fix for whatever is
missing. Non-interactive shells never get prompted, so the installer neither
hangs nor installs anything by surprise in CI.

The name `gho` was picked because nothing claimed it — no binary on `PATH`, no
Homebrew formula. That mattered: the first draft of this tool was called `go`,
which would have shadowed the Go toolchain the moment anyone installed it. The
installer's refusal-to-overwrite check exists for the same reason.

### What maps onto what

Run `gho stack --help` for the verb list and `gho stack <verb> --help` for one
verb's flags and exactly what it runs. `GHO_DRY_RUN=1` prints the commands a
verb would run without running any of them.

| `gho stack` | runs |
| --- | --- |
| `sync` | `gh stack rebase` — `-d/--delete-all` switches to `gh stack sync --prune` |
| `restack`, `r` | `gh stack rebase --no-trunk`, narrowed by `--upstack`/`--downstack`; `--only` is a plain `git rebase --onto <parent>` |
| `modify`, `m` | stage, `git commit --amend`, then `gh stack rebase --upstack --no-trunk` — descendants only, trunk untouched, as Graphite does. `--into <branch>` moves staged work into a lower branch via the stash and restacks above it |
| `create`, `c` | `gh stack add` (or `gh stack init` when no stack exists), then `git commit` |
| `squash`, `sq` | `git reset --soft <base>`, recommit reusing the old messages, then `gh stack rebase --upstack --no-trunk` |
| `submit`, `s`, `ss` | `gh stack submit`; `-r`/`-t` add reviewers with `gh pr edit` afterwards, `-u` degrades to `gh stack push` |
| `log`, `ls`, `ll` | `gh stack view`, `--short`, and a `git log --graph` of the stack |
| `checkout`, `up`, `down`, `top`, `bottom`, `trunk` | the matching `gh stack` navigation commands |
| `get`, `track`, `untrack` | `gh stack checkout`, `gh stack init`, `gh stack unstack --local` |
| `continue`, `abort` | `gh stack rebase --continue` / `--abort` |
| `undo` | restores branch tips saved before the last commit-rewriting verb |
| anything else | `gh stack <verb>`, untouched — `push`, `merge`, `view`, `link`, `unstack`, `switch` |

Only `sync` pulls trunk. Everything that rewrites commits — `modify`, `squash`,
`restack` — stays local and passes `--no-trunk`, which is both what Graphite
does and what lets these verbs work in a repository with no remote at all.

Two deliberate gaps, because faking them would be worse than saying so:

- **Structural edits** — `fold`, `move`, `reorder`, `rename`, `delete`, `insert`
  — open `gh stack modify`, gh's interactive stack editor. It is the only thing
  that reshapes a stack while keeping gh's own metadata consistent, and `gho`
  never writes that metadata itself. Because `gho stack modify` is Graphite's
  amend command, `gho stack restructure` is how you reach gh's version.
- **`absorb`, `split`, `pop`, `freeze`/`unfreeze`** fail with an explanation and
  the closest alternative. `absorb` in particular needs Graphite's
  hunk-to-commit attribution, which neither `gh stack` nor git provides; guessing
  it would quietly amend the wrong commits.

Graphite flags that have no `gh stack` counterpart (`--ai`, `--target-trunk`,
`-a/--all`'s multi-trunk behavior, and so on) exit with an error naming what is
missing, rather than being accepted and ignored.

## Develop

```sh
node --test test.js   # pure logic in core.js
./dev/run.sh          # keyboard chord, hovercard parsing, clipboard payload
./dev/gho.test.sh     # bin/gho's translation into gh and git commands
```

`dev/gho.test.sh` builds a throwaway git repo, feeds `bin/gho` a stubbed
`gh stack view --json` through `GHO_STACK_JSON`, and asserts the exact commands
each verb produces under `GHO_DRY_RUN=1`. No network, no GitHub, no gh-stack
state.

`dev/run.sh` drives the two pages in `dev/` through headless Brave, because the chord handler, the hovercard title parsing, and the clipboard payload all need a real DOM. It stubs the network and the clipboard but runs the extension's own `content.js` unmodified, against a captured hovercard fixture. Point `BROWSER` at another Chromium binary if Brave is not at the default macOS path.

Reload the extension from `brave://extensions` after edits, then reload the GitHub tab — a reloaded extension orphans the old content script until the page refreshes.

To inspect service worker logs, click **service worker** under the extension's card on `brave://extensions`.

## Notes

- GitHub Stacked PRs is currently in private preview.
- Binary files contribute zero changed text lines because unified diffs do not contain their contents.
- Upstream ships no license file, so redistribution terms are unclear — worth asking the author before publishing this anywhere.
