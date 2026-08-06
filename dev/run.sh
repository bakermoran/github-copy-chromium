#!/bin/sh
# Runs the browser-side tests. The keyboard chord, the hovercard parsing and the clipboard
# payload all need a real DOM, so they run in headless Brave rather than under node.
set -e

BROWSER="${BROWSER:-/Applications/Brave Browser.app/Contents/MacOS/Brave Browser}"
DIR=$(cd "$(dirname "$0")" && pwd)
STATUS=0

for page in keyboard copy; do
  echo "── $page.test.html"
  "$BROWSER" --headless=new --disable-gpu --allow-file-access-from-files \
    --virtual-time-budget=6000 --dump-dom "file://$DIR/$page.test.html" 2>/dev/null |
    node -e '
      let html = "";
      process.stdin.on("data", (chunk) => { html += chunk; });
      process.stdin.on("end", () => {
        const match = html.match(/<pre id="out">([\s\S]*?)<\/pre>/);
        if (!match) { console.log("NO OUTPUT — the page failed to run"); process.exit(1); }
        const text = match[1].replace(/&quot;/g, "\"").replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
        console.log(text);
        process.exit(/\bFAIL\b/.test(text) ? 1 : 0);
      });
    ' || STATUS=1
done

exit $STATUS
