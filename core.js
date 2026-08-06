(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PrLinkCore = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  function parsePrUrl(value, base = "https://github.com") {
    let url;
    try {
      url = new URL(value, base);
    } catch (_) {
      return null;
    }

    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (!match || url.hostname !== "github.com") return null;

    return {
      owner: match[1],
      repo: match[2],
      number: Number(match[3]),
      url: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    };
  }

  // The service worker will only fetch canonical PR pages and their diffs, so a message from
  // anywhere else cannot turn it into a general-purpose fetch proxy.
  function isFetchablePrUrl(value) {
    const pr = parsePrUrl(String(value).replace(/\.diff$/, ""));
    if (!pr) return false;
    return value === pr.url || value === `${pr.url}.diff`;
  }

  function countDiff(text) {
    let additions = 0;
    let deletions = 0;

    for (const line of text.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++ ")) additions += 1;
      else if (line.startsWith("-") && !line.startsWith("--- ")) deletions += 1;
    }

    return { additions, deletions };
  }

  function escapeMarkdownTitle(title) {
    return String(title)
      .replace(/\\/g, "\\\\")
      .replace(/([\[\]])/g, "\\$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatPr(pr) {
    const title = escapeMarkdownTitle(pr.title);
    return `[#${pr.number} ${title} \`+${pr.additions}/-${pr.deletions}\`](${pr.url})`;
  }

  function formatPrHtml(pr) {
    const label = `#${pr.number} ${String(pr.title).replace(/\s+/g, " ").trim()}`;
    return `<a href="${escapeHtml(pr.url)}">${escapeHtml(label)} <code>+${pr.additions}/-${pr.deletions}</code></a>`;
  }

  function extractStackPrNumbers(text, stackNumber) {
    const numbers = [];
    const seen = new Set();
    for (const match of String(text).matchAll(/#(\d+)\b/g)) {
      const number = Number(match[1]);
      if (number !== stackNumber && !seen.has(number)) {
        seen.add(number);
        numbers.push(number);
      }
    }
    return numbers;
  }

  function collectPrObjects(value, result = [], seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return result;
    seen.add(value);

    if (Number.isInteger(value.number) && typeof value.title === "string") {
      result.push({
        number: value.number,
        title: value.title,
        url: typeof value.url === "string" ? value.url : null,
      });
    }

    for (const child of Object.values(value)) collectPrObjects(child, result, seen);
    return result;
  }

  return {
    collectPrObjects,
    countDiff,
    escapeMarkdownTitle,
    extractStackPrNumbers,
    formatPr,
    formatPrHtml,
    isFetchablePrUrl,
    parsePrUrl,
  };
});
