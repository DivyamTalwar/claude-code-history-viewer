// The F2a primitive state contract in real browsers (inner-UI plan F2a, D7,
// D10), on the states gallery (states/gallery.tsx: the real
// src/components/ui primitives with the app's index.css).
//
// WebKit, light and dark:
// - keyboard focus on every Button, Input, Textarea, Select and Switch is
//   the base ring: a 2px solid --focus-ring outline, 2px outside;
// - a loading Button keeps the width of the same idle Button (every variant
//   and size), and its label stays its accessible name;
// - an aria-disabled Button computes the same colours, border and cursor as
//   the natively disabled one, also while hovered (no hover step);
// - the Switch thumb travels at least 8px between off and on.
// Chromium with forced colours (WebKit cannot emulate them):
// - the Switch track has a CanvasText border and a CanvasText thumb; on, the
//   track is Highlight and the thumb HighlightText; the thumb still travels
//   at least 8px (D10);
// - keyboard focus is a 2px CanvasText outline on every contract control.
// Computed styles and boxes, not pixel ratios (pixels are `pnpm ui:states`).
// Before F2a (the primitives of origin/develop) the focus, aria-disabled,
// loading and forced-colour checks fail. Skipped without WebKit/Chromium
// (CI_REQUIRE_BROWSER=1 makes that an error).

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, webkit } from "playwright";
import { browserRequirement } from "./requirements.mjs";
import { REPO, buildGallery, keyboardFocus, openGalleryPage, serveDir } from "../states/lib.mjs";
import { isContractControl } from "../states/judge.mjs";

/* global document, getComputedStyle */

const ENABLED = browserRequirement({ webkit: true, chromium: true }, { label: "primitives.states.test" }).enabled;
const MIN_THUMB_TRAVEL = 8;

let outDir;
let server;
let origin;
let webkitBrowser;
let chromiumBrowser;

beforeAll(async () => {
  if (!ENABLED) return;
  outDir = path.join(REPO, ".ui-capture", `states-test-${process.pid}`);
  buildGallery(path.join(outDir, "dist"));
  server = await serveDir(path.join(outDir, "dist"));
  origin = `http://127.0.0.1:${server.address().port}`;
  webkitBrowser = await webkit.launch();
  chromiumBrowser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await webkitBrowser?.close();
  await chromiumBrowser?.close();
  server?.close();
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

async function withGallery(browser, { theme, forcedColors }, fn) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 1400 },
    colorScheme: theme,
    reducedMotion: "reduce",
    ...(forcedColors ? { forcedColors: "active" } : {}),
  });
  try {
    const page = await openGalleryPage(context, origin, theme);
    return await fn(page);
  } finally {
    await context.close();
  }
}

/** The interactive F2a instances (`default` / `checked`), as `{ name, handle }`. */
async function contractControls(page) {
  const out = [];
  for (const handle of await page.$$("[data-ctl]")) {
    const ctl = await handle.getAttribute("data-ctl");
    const src = await handle.getAttribute("data-src");
    if (isContractControl(ctl) && (src === "default" || src === "checked")) out.push({ name: `${ctl}:${src}`, handle });
  }
  return out;
}

/** The computed rgb() of a CSS colour (a system colour or var(--token)) in this page. */
const resolveColor = (page, value) =>
  page.evaluate((v) => {
    const probe = document.createElement("div");
    probe.style.color = v;
    document.body.appendChild(probe);
    const out = getComputedStyle(probe).color;
    probe.remove();
    return out;
  }, value);

const outlineOf = (handle) =>
  handle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, color: cs.outlineColor, focusVisible: el.matches(":focus-visible") };
  });

const look = (handle) =>
  handle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      background: cs.backgroundColor,
      color: cs.color,
      border: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor].join(" "),
      textDecoration: cs.textDecorationLine,
      opacity: cs.opacity,
      cursor: cs.cursor,
    };
  });

/** Thumb x inside its track, for the off and on switches of the gallery. */
const thumbTravel = (page) =>
  page.evaluate(() => {
    const x = (src) => {
      const track = document.querySelector(`[data-ctl="switch:default"][data-src="${src}"]`);
      const thumb = track?.querySelector("span");
      if (!track || !thumb) return NaN;
      return thumb.getBoundingClientRect().left - track.getBoundingClientRect().left;
    };
    return x("checked") - x("default");
  });

describe.skipIf(!ENABLED)("F2a primitive states (real WebKit)", () => {
  it.each(["light", "dark"])("%s: keyboard focus on every Button, Input, Textarea, Select and Switch is the 2px --focus-ring outline, 2px outside", async (theme) => {
    await withGallery(webkitBrowser, { theme }, async (page) => {
      const ring = await resolveColor(page, "var(--focus-ring)");
      const controls = await contractControls(page);
      expect(controls.length).toBeGreaterThan(20);
      const wrong = [];
      for (const { name, handle } of controls) {
        await handle.scrollIntoViewIfNeeded();
        const focus = await keyboardFocus(page, handle, "Alt+Tab");
        const outline = await outlineOf(handle);
        const ok =
          focus.reached && focus.inView && !focus.covered && outline.focusVisible && outline.style === "solid" && outline.width === "2px" && outline.offset === "2px" && outline.color === ring;
        if (!ok) wrong.push(`${name}: ${JSON.stringify({ ...focus, ...outline })}`);
        await handle.evaluate((el) => el.blur());
      }
      expect(wrong).toEqual([]);
    });
  }, 120_000);

  it.each(["light", "dark"])("%s: a loading Button keeps its idle width and its name (every variant and size)", async (theme) => {
    await withGallery(webkitBrowser, { theme }, async (page) => {
      const pairs = await page.evaluate(() => {
        const out = [];
        for (const loading of document.querySelectorAll('[data-ctl^="button:"][data-src="loading"]')) {
          const ctl = loading.getAttribute("data-ctl");
          const idle = document.querySelector(`[data-ctl="${ctl}"][data-src="default"]`);
          out.push({
            ctl,
            idle: idle?.getBoundingClientRect().width ?? NaN,
            loading: loading.getBoundingClientRect().width,
            busy: loading.getAttribute("aria-busy"),
            spinner: !!loading.querySelector('[data-slot="spinner"]'),
          });
        }
        return out;
      });
      expect(pairs.length).toBe(14);
      for (const p of pairs) {
        expect(Math.abs(p.loading - p.idle), `${p.ctl}: ${p.idle} → ${p.loading}`).toBeLessThanOrEqual(0.5);
        expect(p.busy, p.ctl).toBe("true");
        expect(p.spinner, p.ctl).toBe(true);
      }
      const save = page.locator('[data-ctl="button:default"][data-src="loading"]');
      expect(await save.evaluate((el) => el.textContent)).toBe("Save");
      expect(await save.ariaSnapshot()).toContain('button "Save"');
    });
  }, 120_000);

  it.each(["light", "dark"])("%s: an aria-disabled Button looks like the disabled one, also when hovered", async (theme) => {
    await withGallery(webkitBrowser, { theme }, async (page) => {
      const variants = await page.$$eval('[data-ctl^="button:"][data-src="aria-disabled"]', (els) => els.map((e) => e.getAttribute("data-ctl")));
      expect(variants.length).toBe(9);
      for (const ctl of variants) {
        const disabled = page.locator(`[data-ctl="${ctl}"][data-src="disabled"]`);
        const aria = page.locator(`[data-ctl="${ctl}"][data-src="aria-disabled"]`);
        const reference = await look(await disabled.elementHandle());
        expect(await look(await aria.elementHandle()), ctl).toEqual(reference);
        await aria.hover();
        expect(await look(await aria.elementHandle()), `${ctl} hovered`).toEqual(reference);
        await page.mouse.move(1, 1);
        expect(reference.cursor, ctl).toBe("not-allowed");
      }
    });
  }, 120_000);

  it.each(["light", "dark"])("%s: the Switch thumb travels at least 8px", async (theme) => {
    await withGallery(webkitBrowser, { theme }, async (page) => {
      expect(await thumbTravel(page)).toBeGreaterThanOrEqual(MIN_THUMB_TRAVEL);
    });
  }, 60_000);
});

describe.skipIf(!ENABLED)("F2a primitive states (real Chromium, forced colours)", () => {
  it.each(["light", "dark"])("%s: Switch — CanvasText track border and thumb; on: Highlight track, HighlightText thumb; ≥ 8px travel", async (theme) => {
    await withGallery(chromiumBrowser, { theme, forcedColors: true }, async (page) => {
      const system = {
        canvasText: await resolveColor(page, "CanvasText"),
        highlight: await resolveColor(page, "Highlight"),
        highlightText: await resolveColor(page, "HighlightText"),
      };
      expect(system.highlight).not.toBe(system.canvasText);
      const parts = await page.evaluate(() => {
        const part = (src) => {
          const track = document.querySelector(`[data-ctl="switch:default"][data-src="${src}"]`);
          const thumb = track.querySelector("span");
          const t = getComputedStyle(track);
          return {
            border: [t.borderTopColor, t.borderRightColor, t.borderBottomColor, t.borderLeftColor],
            borderWidth: t.borderTopWidth,
            track: t.backgroundColor,
            thumb: getComputedStyle(thumb).backgroundColor,
          };
        };
        return { off: part("default"), on: part("checked") };
      });
      expect(parts.off.border, JSON.stringify(parts)).toEqual(Array(4).fill(system.canvasText));
      expect(parts.off.borderWidth).not.toBe("0px");
      expect(parts.off.thumb).toBe(system.canvasText);
      expect(parts.on.track).toBe(system.highlight);
      expect(parts.on.thumb).toBe(system.highlightText);
      expect(await thumbTravel(page)).toBeGreaterThanOrEqual(MIN_THUMB_TRAVEL);
    });
  }, 60_000);

  it.each(["light", "dark"])("%s: keyboard focus on every contract control is a 2px CanvasText outline", async (theme) => {
    await withGallery(chromiumBrowser, { theme, forcedColors: true }, async (page) => {
      const canvasText = await resolveColor(page, "CanvasText");
      const wrong = [];
      for (const { name, handle } of await contractControls(page)) {
        await handle.scrollIntoViewIfNeeded();
        const focus = await keyboardFocus(page, handle, "Tab");
        const outline = await outlineOf(handle);
        if (!(focus.reached && outline.focusVisible && outline.style === "solid" && outline.width === "2px" && outline.color === canvasText)) {
          wrong.push(`${name}: ${JSON.stringify({ ...focus, ...outline })}`);
        }
        await handle.evaluate((el) => el.blur());
      }
      expect(wrong).toEqual([]);
    });
  }, 120_000);
});
