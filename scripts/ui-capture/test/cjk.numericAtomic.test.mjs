// Numbers never break inside themselves (inner-UI plan F1b, CJK wrapping).
//
// Real WebKit, 390x844 with root font scale 125 % (130 %, the largest app
// setting, where noted), in every CJK UI language.
// Every number in UI text is measured with a DOM Range: its sign, digits,
// separators and what is glued to it (17.6K, 3.5%, 62×) must render on one
// line. A unit after a space (1.4 MB) may move to the next line, as on
// develop. Code, paths and ids are not numbers and are skipped.
//
// Three mechanisms split numbers in the Korean UI, all pinned here:
//   - `overflow-wrap: anywhere` counts its break points in min-content, so a
//     squeezed flex or grid item shrinks to one character: 69 -> 6/9 on the
//     board, 1.4 MB -> 1/./4/M/B on the archive's expiry cards. The base layer
//     uses `break-word`, which never lowers min-content, so no number needs a
//     class to stay whole.
//   - WebKit breaks a keep-all text node that holds Hangul after every
//     punctuation mark, so a date and time rendered as one text node
//     ("… 오후 01:26:25", the message header's details popover) wraps after
//     "01:". keepNumbersWhole() renders such numbers as their own text node.
//   - `break-word` still breaks a single word wider than its whole line. A
//     number gets there only in a box forced narrower than itself, where
//     every language overflows: the token KPI tiles on a phone at 130 %
//     (526.5K -> 526.5/K). Such a value is `whitespace-nowrap`.
// Before the fix (UI_TEST_DIST=<F1b 027986fb build>) the Korean archive and
// transcript cases fail; with break-word alone (ad107289) the Korean KPI
// case fails. Skipped without WebKit or a built server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webkit } from "playwright";
import { browserRequirement } from "./requirements.mjs";
import { openScenario, startApp } from "./appSession.mjs";

/* global document, NodeFilter */

const ENABLED = browserRequirement({ webkit: true, server: true }, { label: "cjk.numericAtomic.test" }).enabled;

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

/**
 * Every number in visible UI text: `core` (sign, digits, separators, a glued
 * K/M/B/T, % or ×), its unit (glued or after a space), the text around it and
 * the number of lines the core spans. Popovers hidden by opacity count: they
 * are laid out and shown on hover.
 */
const numbersOnPage = (page) =>
  page.evaluate(() => {
    const TOKEN =
      /(?<![\p{L}\p{N}_.,:/\\-])(?<core>[+\-\u2212]?\d+(?:[.,:/-]\d+)*(?:[KkMBT](?!\p{L}))?(?:%|\u00d7)?)(?<unit>\u2060?(?:KB|MB|GB|TB|kB|ms|만|억|천|万|亿|萬|億|千|분|초|시간|일|개|회|건|件|個|个|回|次|秒|分|小时|時間|天|日|[smhdx%]))?(?<spaced>[ \u00a0](?:KB|MB|GB|TB|kB|B|ms|s|K|M))?(?![\p{L}\p{N}_])/gu;
    const SKIP = 'pre, code, kbd, samp, textarea, input, [contenteditable="true"]';
    const lines = (node, start, end) => {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.3 && r.height > 0);
      return rects.length ? new Set(rects.map((r) => Math.round(r.top))).size : 0;
    };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? "";
      const el = n.parentElement;
      if (!el || !el.checkVisibility() || el.closest(SKIP)) continue;
      // Paths and ids (a/b, 41ac2d22cac2…) may wrap anywhere; they are not numbers.
      if (/\w[\\/]\w/.test(text) || /[0-9a-f]{12,}/i.test(text)) continue;
      const context = (el.textContent ?? text).trim().slice(0, 80);
      for (const m of text.matchAll(TOKEN)) {
        const { core, unit = "", spaced = "" } = m.groups;
        const coreLines = lines(n, m.index, m.index + core.length);
        if (!coreLines) continue;
        out.push({ text: m[0], core, unit: unit || spaced.trim(), context, lines: coreLines });
      }
    }
    return out;
  });

/** Open `id`, run `prepare` (scrolling, expanding), and measure every number on the page. */
async function measure(id, locale, prepare = async () => {}, fontScale = 1.25) {
  const session = await openScenario(browser, app, id, { locale, variant: { fontScale } });
  try {
    await prepare(session.page);
    return await numbersOnPage(session.page);
  } finally {
    await session.close();
  }
}

const split = (numbers) => numbers.filter((n) => n.lines > 1);
const LOCALES = ["ko", "ja", "zh-CN"];

describe.skipIf(!ENABLED)("numbers never break inside themselves (real WebKit, 390x844)", () => {
  it.each(LOCALES)("%s UI, board at 125%: every metric renders on one line", async (locale) => {
    const numbers = await measure("board--390x844--dark", locale);
    expect(numbers.length, "no numbers visible on the board to measure").toBeGreaterThan(10);
    expect(split(numbers), JSON.stringify(split(numbers))).toEqual([]);
  }, 120_000);

  it.each(LOCALES)("%s UI, archive at 125%: file sizes in the expiry cards keep their number on one line (UI font, no class)", async (locale) => {
    const numbers = await measure("archive--390x844--dark", locale, async (page) => {
      // The expiry cards sit below the fold: bring each size into view as a user would.
      const sizes = page.getByText(/^\d[\d,.]*\s?(?:B|KB|MB|GB|TB)$/);
      for (let i = 0; i < (await sizes.count()); i += 1) await sizes.nth(i).scrollIntoViewIfNeeded();
    });
    const sizes = numbers.filter((n) => /^(?:B|KB|MB|GB|TB)$/.test(n.unit));
    expect(sizes.length, "no file sizes on the archive to measure").toBeGreaterThan(0);
    expect(split(numbers), JSON.stringify(split(numbers))).toEqual([]);
  }, 120_000);

  it.each(LOCALES)("%s UI, transcript at 125%: message times, also inside a localized date in the details popover, stay whole", async (locale) => {
    const numbers = await measure("transcript-mixed-turn--390x844--dark", locale);
    const times = numbers.filter((n) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(n.core) && /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(n.context));
    expect(times.length, "no localized message times to measure").toBeGreaterThan(0);
    expect(split(numbers), JSON.stringify(split(numbers))).toEqual([]);
  }, 120_000);

  it.each(LOCALES)("%s UI, token statistics at 130% (the largest font size): KPI values stay whole in tiles narrower than the value", async (locale) => {
    const numbers = await measure(
      "analytics-tokens--390x844--dark",
      locale,
      async (page) => {
        const tiles = page.locator("button[aria-label] > div.font-mono");
        await tiles.first().scrollIntoViewIfNeeded();
      },
      1.3,
    );
    const kpis = numbers.filter((n) => /^\d+(?:\.\d)?[KMBT]$/.test(n.core) && n.context === n.text);
    expect(kpis.length, "no KPI values on the token statistics to measure").toBeGreaterThan(2);
    expect(split(numbers), JSON.stringify(split(numbers))).toEqual([]);
  }, 120_000);
});
