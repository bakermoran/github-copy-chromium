(function () {
  "use strict";

  const core = globalThis.PrLinkCore;
  const BUTTON_CLASS = "pr-link-copy-button";
  const STACK_BUTTON_CLASS = "pr-stack-copy-button";
  const TOAST_CLASS = "pr-link-copy-toast";
  const CHORD_TIMEOUT = 1500;
  const cache = new Map();
  const buttonWork = new WeakMap();
  let refreshQueued = false;
  let toastTimer = null;
  let chordTimer = null;

  function currentPr() {
    return core.parsePrUrl(location.href);
  }

  function embeddedJson(root = document) {
    const values = [];
    for (const script of root.querySelectorAll('script[type="application/json"]')) {
      try {
        values.push(JSON.parse(script.textContent));
      } catch (_) {
        // GitHub can leave a partial script in the DOM while navigating.
      }
    }
    return values;
  }

  function titleFromDocument(root, number) {
    for (const value of embeddedJson(root)) {
      const match = core.collectPrObjects(value).find((pr) => pr.number === number);
      if (match) return match.title;
    }

    const heading = root.querySelector(
      "h1 .markdown-title, h1 [data-component='Text'], .js-issue-title, [data-testid='pull-request-title']",
    );
    return heading && heading.textContent.trim();
  }

  function diffFromDocument(root) {
    const candidates = root.querySelectorAll(
      "#diff-stats, .diffstat, [aria-label*='addition'][aria-label*='deletion']",
    );
    for (const candidate of candidates) {
      const text = `${candidate.getAttribute("aria-label") || ""} ${candidate.parentElement?.textContent || candidate.textContent}`;
      const labeled = text.match(/([\d,]+)\s+additions?.*?([\d,]+)\s+deletions?/i);
      const compact = text.match(/\+([\d,]+)\s*[−-]([\d,]+)/);
      const match = labeled || compact;
      if (match) {
        return {
          additions: Number(match[1].replaceAll(",", "")),
          deletions: Number(match[2].replaceAll(",", "")),
        };
      }
    }
    return null;
  }

  function titleFromHovercard(html, pr) {
    const root = new DOMParser().parseFromString(html, "text/html");
    const path = new URL(pr.url).pathname;
    for (const link of root.querySelectorAll("a[href]")) {
      if (link.getAttribute("href") !== path) continue;
      const title = link.querySelector(".markdown-title");
      if (title) return title.textContent.trim();
    }
    return null;
  }

  async function fetchTitle(pr) {
    // The hovercard partial is a couple of kilobytes and answers in a fraction of the time
    // the full PR page takes, which is what makes a multi-PR stack feel instant.
    const hovercard = await fetch(`${pr.url}/hovercard`, {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" },
    }).catch(() => null);

    if (hovercard?.ok) {
      const title = titleFromHovercard(await hovercard.text(), pr);
      if (title) return title;
    }

    // Same-origin, so this keeps the user's GitHub session and reaches private repos.
    const response = await fetch(pr.url, { credentials: "include" });
    if (!response.ok) throw new Error(`Could not load PR #${pr.number}`);
    const html = await response.text();
    return titleFromDocument(new DOMParser().parseFromString(html, "text/html"), pr.number);
  }

  async function fetchFromWorker(url) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "fetch-text", url });
    } catch (error) {
      // A reloaded extension orphans the content script until the page is refreshed.
      throw new Error(
        /context invalidated/i.test(error.message)
          ? "The extension was updated — reload this page"
          : error.message,
      );
    }
    if (!response) throw new Error("The extension service worker did not respond");
    if (!response.ok) throw new Error(response.error);
    return response.text;
  }

  async function fetchDiff(pr) {
    // The .diff URL redirects to patch-diff.githubusercontent.com, which sends no CORS
    // headers, so this has to go through the service worker. The direct attempt is only a
    // fallback for the case where the worker is unavailable.
    try {
      return await fetchFromWorker(`${pr.url}.diff`);
    } catch (error) {
      const direct = await fetch(`${pr.url}.diff`, {
        credentials: "include",
        headers: { Accept: "text/plain" },
      }).catch(() => null);
      if (direct?.ok) return direct.text();
      throw new Error(`Could not load the diff for PR #${pr.number}: ${error.message}`);
    }
  }

  async function fetchPr(pr, knownTitle) {
    if (cache.has(pr.url)) return cache.get(pr.url);

    const pending = (async () => {
      const shownDiff = currentPr()?.url === pr.url ? diffFromDocument(document) : null;
      const [title, diff] = await Promise.all([
        knownTitle || fetchTitle(pr),
        shownDiff || fetchDiff(pr).then(core.countDiff),
      ]);
      if (!title) throw new Error(`Could not find the title for PR #${pr.number}`);

      return { ...pr, title, ...diff };
    })();

    cache.set(pr.url, pending);
    try {
      return await pending;
    } catch (error) {
      cache.delete(pr.url);
      throw error;
    }
  }

  async function writeClipboard(content) {
    const text = typeof content === "string" ? content : content.text;
    const html = typeof content === "string" ? null : content.html;

    if (html && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" }),
          }),
        ]);
        return;
      } catch (_) {
        // Chromium rejects clipboard.write() once the click's user activation has expired,
        // which a slow diff fetch can outlast. execCommand still works via clipboardWrite.
      }
    }

    if (html) {
      const richText = document.createElement("div");
      richText.contentEditable = "true";
      const parsed = new DOMParser().parseFromString(html, "text/html");
      richText.append(...parsed.body.childNodes);
      richText.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(richText);
      const range = document.createRange();
      range.selectNodeContents(richText);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const copied = document.execCommand("copy");
      selection.removeAllRanges();
      richText.remove();
      if (!copied) throw new Error("The browser denied clipboard access");
      return;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("The browser denied clipboard access");
  }

  function setButtonState(button, text, state) {
    button.textContent = text;
    button.dataset.state = state || "";
    button.disabled = state === "loading";
  }

  // A keyboard copy can happen while the button is scrolled out of view, so the result is
  // also reported next to the cursor's attention rather than only on the button.
  function showToast(message, state) {
    let toast = document.querySelector(`.${TOAST_CLASS}`);
    if (!toast) {
      toast = document.createElement("div");
      toast.className = TOAST_CLASS;
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      // Shown as a popover so it lands in the top layer; the stack lives in a modal dialog,
      // which would otherwise paint over the toast whatever its z-index.
      toast.setAttribute("popover", "manual");
      document.body.append(toast);
      try {
        toast.showPopover();
      } catch (_) {
        toast.removeAttribute("popover"); // Without popover support it stays a fixed element.
      }
    }
    toast.textContent = message;
    toast.dataset.state = state || "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 2400);
  }

  async function runCopy(button, work, successText, announce) {
    const original = button.textContent;
    setButtonState(button, "Copying…", "loading");
    try {
      await writeClipboard(await work());
      setButtonState(button, successText, "success");
      if (announce) showToast(successText, "success");
    } catch (error) {
      console.error("GitHub PR Link Copier:", error);
      setButtonState(button, "Copy failed", "error");
      button.title = error.message;
      if (announce) showToast(error.message, "error");
    }
    setTimeout(() => setButtonState(button, original, ""), 1800);
  }

  function makeButton(text, className, work, successText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `${BUTTON_CLASS} ${className || ""}`.trim();
    button.textContent = text;
    buttonWork.set(button, { work, successText });
    button.addEventListener("click", () => runCopy(button, work, successText, false));
    return button;
  }

  function findHeaderTarget() {
    const actions = document.querySelector(
      ".gh-header-actions, [data-component='PH_Actions']:not(.d-none)",
    );
    if (actions) return { element: actions, placement: "prepend" };

    const title = document.querySelector(
      "h1 .markdown-title, h1 [data-component='Text'], .gh-header-title .js-issue-title",
    );
    if (!title) return null;
    return { element: title.closest("h1")?.parentElement || title.parentElement, placement: "append" };
  }

  function addPrButton() {
    const pr = currentPr();
    const target = findHeaderTarget();
    if (!pr || !target || document.querySelector(`.${BUTTON_CLASS}:not(.${STACK_BUTTON_CLASS})`)) return;

    const button = makeButton(
      "Copy PR link",
      "",
      async () => {
        const fullPr = await fetchPr(pr, titleFromDocument(document, pr.number));
        return { text: core.formatPr(fullPr), html: core.formatPrHtml(fullPr) };
      },
      "Copied!",
    );
    target.element[target.placement](button);
  }

  function normalizeStackEntries(entries, current) {
    const unique = new Map();
    for (const entry of entries) {
      const parsed = entry.url && core.parsePrUrl(entry.url, location.origin);
      const pr = parsed || (entry.number
        ? { ...current, number: entry.number, url: `https://github.com/${current.owner}/${current.repo}/pull/${entry.number}` }
        : null);
      if (pr && pr.owner === current.owner && pr.repo === current.repo) {
        unique.set(pr.url, { ...pr, title: entry.title || null });
      }
    }
    return [...unique.values()];
  }

  function stackEntries(container) {
    const current = currentPr();
    if (!current) return [];
    const entries = [];

    for (const link of container.querySelectorAll('a[href*="/pull/"]')) {
      const parsed = core.parsePrUrl(link.href);
      if (parsed) entries.push({ ...parsed, title: null });
    }

    for (const element of container.querySelectorAll("*")) {
      const ownText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ")
        .trim();
      const number = ownText.match(/^#(\d+)\b/)?.[1];
      if (number) entries.push({ number: Number(number), title: null, url: null });
    }

    const stackNumber = Number(container.textContent.match(/Stack\s*#\s*(\d+)/i)?.[1]);
    for (const number of core.extractStackPrNumbers(container.textContent, stackNumber)) {
      entries.push({ number, title: null, url: null });
    }

    for (const value of embeddedJson(document)) {
      const layout = value?.payload?.pullRequestsConversationsRoute?.pullRequestsLayoutRoute;
      const stack = layout?.stack;
      if (stack) entries.push(...core.collectPrObjects(stack));
    }

    return normalizeStackEntries(entries, current);
  }

  function isStackDialog(element) {
    return /Stack\s*#\s*\d+/i.test(element.textContent || "");
  }

  function stackContainers() {
    const containers = new Set();
    const titlePattern = /^Stack\s*#\s*\d+$/i;

    for (const element of document.querySelectorAll("h1, h2, h3, [role='heading'], div, span")) {
      if (!titlePattern.test(element.textContent.trim())) continue;
      if ([...element.children].some((child) => titlePattern.test(child.textContent.trim()))) continue;

      let container = element.parentElement;
      while (container && container !== document.body) {
        const numbers = new Set([...container.textContent.matchAll(/#(\d+)\b/g)].map((match) => match[1]));
        if (numbers.size >= 2) {
          containers.add(container);
          break;
        }
        container = container.parentElement;
      }
    }

    if (containers.size === 0) {
      const fallbacks = [...document.querySelectorAll("dialog, [role='dialog'], .Overlay, [class*='Overlay']")]
        .filter(isStackDialog)
        .sort((a, b) => a.textContent.length - b.textContent.length);
      if (fallbacks[0]) containers.add(fallbacks[0]);
    }

    return [...containers];
  }

  function addStackButtons() {
    for (const container of stackContainers()) {
      if (container.querySelector(`.${STACK_BUTTON_CLASS}`)) continue;

      const button = makeButton(
        "Copy Stack",
        STACK_BUTTON_CLASS,
        async () => {
          const entries = stackEntries(container);
          if (entries.length < 2) throw new Error("Could not find the PRs in this stack");
          // Fetched together rather than one after another; Promise.all keeps stack order.
          const prs = await Promise.all(entries.map((entry) => fetchPr(entry, entry.title)));
          return {
            text: prs.map((pr) => `- ${core.formatPr(pr)}`).join("\n"),
            html: `<ul>${prs.map((pr) => `<li>${core.formatPrHtml(pr)}</li>`).join("")}</ul>`,
          };
        },
        "Stack copied!",
      );

      const titlePattern = /^Stack\s*#\s*\d+$/i;
      const title = [...container.querySelectorAll("h1, h2, h3, [role='heading'], div, span")].find(
        (node) => titlePattern.test(node.textContent.trim())
          && ![...node.children].some((child) => titlePattern.test(child.textContent.trim())),
      );
      if (title) title.after(button);
      else container.prepend(button);
    }
  }

  function isTypingContext(event) {
    // composedPath()[0] sees through GitHub's shadow-DOM editors, which retarget event.target.
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return [path[0], event.target, document.activeElement].some(
      (node) => node instanceof Element
        && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)),
    );
  }

  function copyViaShortcut(selector, unavailableMessage) {
    const button = document.querySelector(selector);
    const work = button && buttonWork.get(button);
    if (!work) {
      showToast(unavailableMessage, "error");
      return;
    }
    if (button.disabled) return; // A copy is already running.
    runCopy(button, work.work, work.successText, true);
  }

  function claimKey(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function armChord(event) {
    // "c" is claimed outright so the chord cannot be broken by a GitHub binding on it.
    claimKey(event);
    clearTimeout(chordTimer);
    chordTimer = setTimeout(() => {
      chordTimer = null;
    }, CHORD_TIMEOUT);
  }

  function handleChord(event) {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (isTypingContext(event)) {
      clearTimeout(chordTimer);
      chordTimer = null;
      return;
    }

    const key = event.key.toLowerCase();

    if (chordTimer === null) {
      if (key === "c") armChord(event);
      return;
    }

    if (key === "c") {
      armChord(event); // A second "c" restarts the chord rather than cancelling it.
      return;
    }

    clearTimeout(chordTimer);
    chordTimer = null;
    if (key !== "l" && key !== "s") return;

    // GitHub binds bare "l" to labels and "s" to search. Claiming the key here, in the
    // capture phase on window, stops it before any of GitHub's own handlers run.
    claimKey(event);

    if (key === "l") {
      copyViaShortcut(`.${BUTTON_CLASS}:not(.${STACK_BUTTON_CLASS})`, "Copy PR link is not ready yet");
    } else {
      copyViaShortcut(`.${STACK_BUTTON_CLASS}`, "Open the stack to copy it");
    }
  }

  function refresh() {
    refreshQueued = false;
    if (!currentPr()) return;
    addPrButton();
    addStackButtons();
  }

  function queueRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(refresh);
  }

  window.addEventListener("keydown", handleChord, true);
  new MutationObserver(queueRefresh).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("turbo:load", queueRefresh);
  document.addEventListener("pjax:end", queueRefresh);
  queueRefresh();
})();
