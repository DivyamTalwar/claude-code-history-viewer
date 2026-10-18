/**
 * One place, one name (plan F4a, D17; audit G-MC2, V-GS1).
 *
 * `PLACE_NAMES` gives every named place one i18n key, and the sidebar, the
 * header tab, the content title, the palette and the phone tab bar all read
 * it. Places that differ in scope get a scoped name ("Analytics" /
 * "Analytics · All projects"), never a second noun ("Global Statistics" vs
 * "Global Overview"). The keys the old second names lived in are retired: a
 * locale file or a call site bringing one back fails here.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { VIEWS } from "@/navigation/place";
import { PLACE_NAMES, UNNAMED_VIEWS, placeNameKey } from "@/navigation/placeNames";
import { VIEW_REGISTRY } from "@/layouts/shell/viewRegistry";
import { BottomTabBar } from "@/components/mobile/BottomTabBar";

const SRC = path.resolve(__dirname, "..");
const LOCALES = ["en", "ko", "ja", "zh-CN", "zh-TW"] as const;

/** Keys that held a second name for a place before the table. */
const RETIRED_NAME_KEYS = [
  "analytics.dashboard",
  "analytics.globalOverview",
  "archive.title",
  "archive.settings.link",
  "common.mobile.tab.analytics",
  "common.mobile.tab.board",
  "common.mobile.tab.messages",
  "message.view",
  "project.globalStats",
  "project.library.archive",
  "recentEdits.title",
  "session.board.title",
];

function localeStrings(locale: string): Record<string, string> {
  const dir = path.join(SRC, "i18n", "locales", locale);
  const out: Record<string, string> = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    Object.assign(out, JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "locales" ? [] : sourceFiles(full);
    return /\.(ts|tsx|json)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && entry.name !== "types.generated.ts"
      ? [full]
      : [];
  });
}

afterEach(() => {
  cleanup();
});

describe("place names", () => {
  it("names every view or says why it has no name yet", () => {
    for (const view of VIEWS) {
      const named = view in PLACE_NAMES;
      const unnamed = view in UNNAMED_VIEWS;
      expect(named !== unnamed, view).toBe(true);
    }
  });

  it.each(LOCALES)("%s: every place name exists and no two places share one", (locale) => {
    const strings = localeStrings(locale);
    const names = Object.values(PLACE_NAMES).map((key) => strings[key]);
    for (const [view, key] of Object.entries(PLACE_NAMES)) {
      expect(strings[key], `${locale} ${view} (${key})`).toBeTruthy();
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(LOCALES)("%s: global stats is the analytics name with its scope", (locale) => {
    const strings = localeStrings(locale);
    const analytics = strings[PLACE_NAMES.analytics] ?? "";
    expect(strings[PLACE_NAMES.globalStats]?.startsWith(`${analytics} · `)).toBe(true);
  });

  it("titles and header tabs read the table", () => {
    for (const [view, key] of Object.entries(PLACE_NAMES)) {
      const entry = VIEW_REGISTRY[view as keyof typeof VIEW_REGISTRY];
      expect(entry.titleKey, view).toBe(key);
      if ("tab" in entry && entry.tab) expect(entry.tab.labelKey, view).toBe(key);
    }
  });

  it.each(LOCALES)("%s: the phone tab bar shows the same names", async (locale) => {
    await i18n.changeLanguage(locale);
    render(<BottomTabBar activeTab="messages" onOpenSidebar={vi.fn()} onSwitchView={vi.fn()} hasProject />);
    for (const view of ["conversation", "board", "analytics"] as const) {
      expect(screen.getByRole("button", { name: i18n.t(placeNameKey(view)) }), view).toBeTruthy();
    }
    await i18n.changeLanguage("en");
  });

  it.each(LOCALES)("%s: the palette's archive command names the archive", (locale) => {
    const strings = localeStrings(locale);
    expect(strings["common.command.openArchive"]).toContain(strings[PLACE_NAMES.archive]);
  });

  it("retired second names are gone from every locale and every call site", () => {
    for (const locale of LOCALES) {
      const strings = localeStrings(locale);
      expect(RETIRED_NAME_KEYS.filter((key) => key in strings), locale).toEqual([]);
    }
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return RETIRED_NAME_KEYS.filter((key) => new RegExp(`["'\`]${key.replace(/\./g, "\\.")}["'\`]`).test(text)).map(
        (key) => `${path.relative(SRC, file)}: ${key}`,
      );
    });
    expect(offenders).toEqual([]);
  });
});
