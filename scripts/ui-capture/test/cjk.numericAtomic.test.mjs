// Numeric tokens never break inside themselves (inner-UI plan F1b, CJK
// wrapping follow-up).
//
// Real WebKit, the session board at 390x844 with root font scale 125%, in
// every CJK UI language. The board's metrics are plain numbers and compact
// magnitudes (69, 181, 17.6K, 501.3K); a numeric token must always render on
// one line. F1b's global Korean `overflow-wrap: anywhere` let a squeezed flex
// item size down to a single digit and split 69 into 6/9 — this test pins the
// invariant so the wrapping rule can never bite numbers again.
// Before the fix (UI_TEST_DIST=<F1b head without the atomic-number rule>)
// the Korean case fails. Skipped without WebKit or a built server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webkit } from "playwright";
import { browserRequirement } from "./requirements.mjs";
import { openScenario, startApp } from "./appSession.mjs";

/* global document, getComputedStyle, NodeFilter */

const ENABLED = browserRequirement({ webkit: true, server: true }, { label: "cjk.numericAtomic.test" }).enabled;

// A whole text node that is one numeric token: digits with optional
// thousands separators / decimal point, an optional compact-magnitude
// suffix (ASCII or CJK: 17.6K, 501.3K, 1.8万, 5940만) and optional %.
const NUMERIC_TOKEN = /^\d[\d,.]*\s*(?:[KkMmB]|만|万|억|천)?%?$/;

let app;
let browser;

beforeAll(async () => {
  if (!ENABLED) return;
  app = await startApp("cjk-numeric-atomic");
  browser = await webkit.launch();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await app?.stop();
});

/** Visible text nodes that are a single numeric token and their rendered line counts. */
const numericTokenLines = (page) =>
  page.evaluate(() => {
    const NUMERIC_TOKEN = /^\d[\d,.]*\s*(?:[KkMmB]|만|万|억|천)?%?$/;
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const value = n.nodeValue ?? "";
      if (!NUMERIC_TOKEN.test(value)) continue;
      const el = n.parentElement;
      if (!el || !el.checkVisibility()) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const lines =
        new Set(
          [...range.getClientRects()]
            .filter((r) => r.width > 1 && r.height > 0)
            .map((r) => Math.round(r.top)),
        ).size || 1;
      out.push({
        text: value,
        lines,
        overflowWrap: getComputedStyle(el).overflowWrap,
      });
    }
    return out;
  });

describe.skipIf(!ENABLED)("atomic numeric tokens (real WebKit)", () => {
  it.each(["ko", "ja", "zh-CN"])(
    "%s UI, board at 390x844 / font scale 125%: every numeric metric renders on one line",
    async (locale) => {
      const session = await openScenario(browser, app, "board--390x844--dark", {
        locale,
        variant: { fontScale: 1.25 },
      });
      try {
        const nodes = await numericTokenLines(session.page);
        expect(nodes.length, "no numeric metrics visible on the board to measure").toBeGreaterThan(0);
        const split = nodes.filter((n) => n.lines > 1);
        expect(split, JSON.stringify(split)).toEqual([]);
      } finally {
        await session.close();
      }
    },
    120_000,
  );
});
