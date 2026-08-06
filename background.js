"use strict";

// https://github.com/<owner>/<repo>/pull/<n>.diff redirects to
// patch-diff.githubusercontent.com, which sends no CORS headers. Manifest V3 content scripts
// are subject to CORS, so that fetch would fail on the redirect. Service worker fetches use
// the extension's own network context and bypass CORS for the hosts in host_permissions,
// so the content script asks for the diff here instead.
importScripts("core.js");

const core = globalThis.PrLinkCore;

async function fetchText(url) {
  const response = await fetch(url, {
    credentials: "include",
    headers: { Accept: "text/plain" },
  });
  if (!response.ok) throw new Error(`GitHub responded with HTTP ${response.status}`);
  return response.text();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "fetch-text") return false;

  // The content script only runs on github.com PR pages, but keep the worker from being a
  // general-purpose fetch proxy for anything else that manages to send it a message.
  if (sender.id !== chrome.runtime.id || !core.isFetchablePrUrl(message.url)) {
    sendResponse({ ok: false, error: "Refused to fetch an unexpected URL" });
    return false;
  }

  fetchText(message.url)
    .then((text) => ({ ok: true, text }))
    .catch((error) => ({ ok: false, error: error.message }))
    .then(sendResponse);

  return true; // Keeps the message channel open for the async response.
});
