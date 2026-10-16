import { describe, expect, it } from "vitest";
import { matchesCommandQuery } from "./paletteQuery";

describe("matchesCommandQuery", () => {
  it("matches every query word against the start of a title word", () => {
    expect(matchesCommandQuery("sett", "Open Settings Manager", "go.settingsManager")).toBe(true);
    expect(matchesCommandQuery("open arch", "Open Archive Manager", "go.archive")).toBe(true);
    expect(matchesCommandQuery("ettings", "Open Settings Manager", "go.settingsManager")).toBe(false);
  });

  it("matches the id's words too", () => {
    expect(matchesCommandQuery("minimap", "Show or Hide Session Minimap", "view.toggleMinimap")).toBe(true);
    expect(matchesCommandQuery("toggle", "Show or Hide Session Minimap", "view.toggleMinimap")).toBe(true);
  });

  it("matches everything for an empty query", () => {
    expect(matchesCommandQuery("  ", "Back", "go.back")).toBe(true);
  });

  it("matches Korean by word and Japanese/Chinese anywhere in the title", () => {
    expect(matchesCommandQuery("설정", "설정 관리자 열기", "go.settingsManager")).toBe(true);
    expect(matchesCommandQuery("マネージャー", "設定マネージャーを開く", "go.settingsManager")).toBe(true);
    expect(matchesCommandQuery("管理器", "打开设置管理器", "go.settingsManager")).toBe(true);
    expect(matchesCommandQuery("归档", "打开设置管理器", "go.settingsManager")).toBe(false);
  });
});
