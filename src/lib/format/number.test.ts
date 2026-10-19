import { describe, expect, it } from "vitest";
import {
  COMPACT_FROM,
  formatBytes,
  formatChange,
  formatCost,
  formatCount,
  formatNumber,
  formatPercent,
  formatTokens,
} from "./number";
import { withOsLocale } from "@/test/osLocale";

const LANGUAGES = ["en", "ko", "ja", "zh-CN", "zh-TW"] as const;

describe("formatNumber / formatTokens", () => {
  it("groups below 10K and compacts from 10K up", () => {
    expect(COMPACT_FROM).toBe(10_000);
    expect(formatTokens(0, "en")).toBe("0");
    expect(formatTokens(999, "en")).toBe("999");
    expect(formatTokens(1_434, "en")).toBe("1,434");
    expect(formatTokens(9_999, "en")).toBe("9,999");
    expect(formatTokens(10_000, "en")).toBe("10K");
    expect(formatTokens(12_345, "en")).toBe("12.3K");
    expect(formatTokens(123_456, "en")).toBe("123K");
    expect(formatTokens(1_234_567, "en")).toBe("1.2M");
    expect(formatTokens(51_400_000, "en")).toBe("51.4M");
  });

  it.each([
    ["en", "59.4M", "51.4M", "1.2M", "9,999"],
    ["ko", "5940만", "5140만", "123만", "9,999"],
    ["ja", "5940万", "5140万", "123万", "9,999"],
    ["zh-CN", "5940万", "5140万", "123万", "9,999"],
    ["zh-TW", "5940萬", "5140萬", "123萬", "9,999"],
  ])("uses the app language's compact units (%s)", (lang, a, b, c, small) => {
    expect(formatTokens(59_427_870, lang)).toBe(a);
    expect(formatTokens(51_400_000, lang)).toBe(b);
    expect(formatTokens(1_234_567, lang)).toBe(c);
    expect(formatTokens(9_999, lang)).toBe(small);
  });

  it("formats the audit's mixed pair the same way on one screen", () => {
    // Global stats showed provider totals grouped ('59,427,870') beside
    // model totals compact ('51.4M'). Both are token totals → one style.
    const provider = formatTokens(59_427_870, "en");
    const model = formatTokens(51_400_000, "en");
    expect([provider, model]).toEqual(["59.4M", "51.4M"]);
    expect(provider).not.toMatch(/,/);
  });

  it("keeps counts grouped at any size", () => {
    expect(formatCount(1_369, "en")).toBe("1,369");
    expect(formatCount(59_427_870, "en")).toBe("59,427,870");
    expect(formatNumber(59_427_870, "en", { style: "grouped" })).toBe("59,427,870");
    expect(formatNumber(1_500, "en", { style: "compact" })).toBe("1.5K");
  });

  it("shows a dash for values that are not numbers", () => {
    expect(formatTokens(Number.NaN, "en")).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY, "en")).toBe("—");
  });

  it("handles negative values symmetrically", () => {
    expect(formatTokens(-12_345, "en")).toBe("-12.3K");
    expect(formatCount(-1_234, "en")).toBe("-1,234");
  });
});

describe("formatCost", () => {
  it("always shows two decimals with a dollar sign", () => {
    expect(formatCost(34.1, "en")).toBe("$34.10");
    expect(formatCost(6.857, "en")).toBe("$6.86");
    expect(formatCost(0.49, "en")).toBe("$0.49");
    expect(formatCost(1234.5, "en")).toBe("$1,234.50");
    expect(formatCost(0, "en")).toBe("$0.00");
  });

  it("says '<$0.01' for every positive cost under a cent, on both sides of half a cent", () => {
    expect(formatCost(0.0000001, "en")).toBe("<$0.01");
    expect(formatCost(0.004, "en")).toBe("<$0.01");
    expect(formatCost(0.0049, "en")).toBe("<$0.01");
    expect(formatCost(0.005, "en")).toBe("<$0.01");
    expect(formatCost(0.006, "en")).toBe("<$0.01");
    expect(formatCost(0.00999, "en")).toBe("<$0.01");
    // One cent and above keeps the normal two decimals.
    expect(formatCost(0.01, "en")).toBe("$0.01");
    expect(formatCost(0.0101, "en")).toBe("$0.01");
  });

  it.each(LANGUAGES)("uses a plain $ (not US$) in %s", (lang) => {
    expect(formatCost(1234.5, lang)).toBe("$1,234.50");
    expect(formatCost(0.006, lang)).toBe("<$0.01");
    expect(formatCost(0.01, lang)).toBe("$0.01");
  });
});

describe("formatPercent", () => {
  it("rounds to whole percents", () => {
    expect(formatPercent(0.453, "en")).toBe("45%");
    expect(formatPercent(0.4549, "en")).toBe("45%");
    expect(formatPercent(1, "en")).toBe("100%");
    expect(formatPercent(0, "en")).toBe("0%");
  });

  it("never rounds a non-zero share to 0% or a partial share to 100%", () => {
    expect(formatPercent(0.001, "en")).toBe("<1%");
    expect(formatPercent(0.998, "en")).toBe(">99%");
  });

  it("sends 99.5% and above to '>99%' — a partial share is never 100%", () => {
    expect(formatPercent(0.9949, "en")).toBe("99%");
    expect(formatPercent(0.995, "en")).toBe(">99%");
    expect(formatPercent(0.9951, "en")).toBe(">99%");
    expect(formatPercent(0.9999, "en")).toBe(">99%");
    expect(formatPercent(1, "en")).toBe("100%");
  });

  it("rounds exactly half a percent up to a real 1%", () => {
    expect(formatPercent(0.005, "en")).toBe("1%");
    expect(formatPercent(0.0049, "en")).toBe("<1%");
  });

  it.each(LANGUAGES)("formats in %s", (lang) => {
    expect(formatPercent(0.453, lang)).toBe("45%");
    expect(formatPercent(0.995, lang)).toBe(">99%");
  });
});

describe("formatChange", () => {
  it("reports direction and size without judging it", () => {
    expect(formatChange(100, 125, "en")).toEqual({ direction: "up", text: "+25%" });
    expect(formatChange(100, 80, "en")).toEqual({ direction: "down", text: "-20%" });
    expect(formatChange(100, 100, "en")).toEqual({ direction: "flat", text: "0%" });
  });

  it("has no percentage when there is nothing to compare against", () => {
    expect(formatChange(0, 10, "en")).toEqual({ direction: "new", text: "" });
    expect(formatChange(0, 0, "en")).toEqual({ direction: "flat", text: "0%" });
  });
});

describe("formatBytes", () => {
  it("keeps the existing binary steps with one decimal", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
    expect(formatBytes(0.5, "en")).toBe("0 B");
    expect(formatBytes(512, "en")).toBe("512.0 B");
    expect(formatBytes(1024, "en")).toBe("1.0 KB");
    expect(formatBytes(-1024, "en")).toBe("-1.0 KB");
    expect(formatBytes(1536 * 1024, "en")).toBe("1.5 MB");
    expect(formatBytes(Number.NaN, "en")).toBe("0 B");
    expect(formatBytes(1024 ** 6, "en")).toMatch(/ TB$/);
  });
});

describe("app language, not the OS locale", () => {
  it("ignores an OS locale that differs from the app language", () => {
    withOsLocale("ko-KR", () => {
      // Control: the stub really changes the OS default.
      expect((59_427_870).toLocaleString(undefined, { notation: "compact" })).toMatch(/만/);
      expect(formatTokens(59_427_870, "en")).toBe("59.4M");
      expect(formatCost(1234.5, "en")).toBe("$1,234.50");
      expect(formatPercent(0.453, "en")).toBe("45%");
    });
    withOsLocale("de-DE", () => {
      expect(formatCount(1_369, "en")).toBe("1,369");
      expect(formatCount(1_369, "ko")).toBe("1,369");
    });
  });
});
