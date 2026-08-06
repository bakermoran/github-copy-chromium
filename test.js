const assert = require("node:assert/strict");
const test = require("node:test");
const core = require("./core");

test("parses and canonicalizes GitHub PR URLs", () => {
  assert.deepEqual(core.parsePrUrl("https://github.com/acme/widgets/pull/42/files"), {
    owner: "acme",
    repo: "widgets",
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
  });
  assert.equal(core.parsePrUrl("https://example.com/acme/widgets/pull/42"), null);
});

test("only lets the service worker fetch canonical PR pages and diffs", () => {
  assert.equal(core.isFetchablePrUrl("https://github.com/acme/widgets/pull/42"), true);
  assert.equal(core.isFetchablePrUrl("https://github.com/acme/widgets/pull/42.diff"), true);
  assert.equal(core.isFetchablePrUrl("https://github.com/acme/widgets/pull/42/files"), false);
  assert.equal(core.isFetchablePrUrl("https://github.com/settings/tokens"), false);
  assert.equal(core.isFetchablePrUrl("https://example.com/acme/widgets/pull/42.diff"), false);
});

test("counts changed lines without counting diff headers", () => {
  const diff = [
    "diff --git a/file b/file",
    "--- a/file",
    "+++ b/file",
    "@@ -1,2 +1,3 @@",
    "-old",
    "+new",
    "+another",
    "++++source line beginning with pluses",
    "----source line beginning with minuses",
    " context",
  ].join("\n");
  assert.deepEqual(core.countDiff(diff), { additions: 3, deletions: 2 });
});

test("formats the requested Markdown and escapes title brackets", () => {
  assert.equal(
    core.formatPr({
      number: 24,
      title: "Add [secure] auth",
      additions: 18,
      deletions: 3,
      url: "https://github.com/acme/widgets/pull/24",
    }),
    "[#24 Add \\[secure\\] auth `+18/-3`](https://github.com/acme/widgets/pull/24)",
  );
});

test("formats rich HTML for Slack and escapes untrusted PR data", () => {
  assert.equal(
    core.formatPrHtml({
      number: 24,
      title: "Fix <auth> & sessions",
      additions: 18,
      deletions: 3,
      url: "https://github.com/acme/widgets/pull/24?x=1&y=2",
    }),
    '<a href="https://github.com/acme/widgets/pull/24?x=1&amp;y=2">#24 Fix &lt;auth&gt; &amp; sessions <code>+18/-3</code></a>',
  );
});

test("finds nested PR data used by GitHub's stack payload", () => {
  const payload = { stack: { entries: [{ pullRequest: { number: 2, title: "Second" } }] } };
  assert.deepEqual(core.collectPrObjects(payload), [{ number: 2, title: "Second", url: null }]);
});

test("extracts PRs in displayed stack order and excludes the stack number", () => {
  const text = "Stack #49634 Delivery: Hermes #49633 · branch Delivery: Olympus #49632 · branch main";
  assert.deepEqual(core.extractStackPrNumbers(text, 49634), [49633, 49632]);
});
