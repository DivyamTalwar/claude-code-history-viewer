import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keepNumbersWhole } from "./keepNumbersWhole";

/**
 * The real-WebKit side (a Korean date and time in the message header popover
 * stays on one line at 390 px / 125 %) is in
 * scripts/ui-capture/test/cjk.numericAtomic.test.mjs.
 */
describe("keepNumbersWhole", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["2026년 6월 19일 오후 01:26:25", ["2026년 6월 19일 오후 ", "01:26:25"]],
    ["오전 7:05", ["오전 ", "7:05"]],
    ["총 1,234,567개", ["총 ", "1,234,567", "개"]],
    ["입력: 17.6K", ["입력: ", "17.6K"]],
    ["12.5% 증가", ["12.5%", " 증가"]],
    ["−1,200 → +3,400", ["−1,200", " → ", "+3,400"]],
    ["2026/06/19", ["2026/06/19"]],
  ])("splits %j so each punctuated number is its own part", (text, parts) => {
    expect(keepNumbersWhole(text)).toEqual(parts);
    expect((keepNumbersWhole(text) as string[]).join("")).toBe(text);
  });

  it.each(["2026년 6월 19일", "메시지 12개", "", "PR 42 --strict", "1.", "a.b"])(
    "returns %j unchanged when no number has inner punctuation",
    (text) => {
      expect(keepNumbersWhole(text)).toBe(text);
    },
  );

  it("renders each part as its own text node, with the same visible text and no key warning", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<p>{keepNumbersWhole("2026년 6월 19일 오후 01:26:25")}</p>);
    const p = container.querySelector("p")!;
    expect(p.textContent).toBe("2026년 6월 19일 오후 01:26:25");
    expect([...p.childNodes].map((n) => [n.nodeType, n.nodeValue])).toEqual([
      [Node.TEXT_NODE, "2026년 6월 19일 오후 "],
      [Node.TEXT_NODE, "01:26:25"],
    ]);
    expect(error).not.toHaveBeenCalled();
  });
});

/**
 * The shared formatters (`useFormat()` / `appFormat()`, src/lib/format) return
 * localized dates and times such as "2026년 6월 19일 오후 1:26:25". Rendered
 * as a JSX child, the result of `.time()`, `.dateTime()` or `.dateTimeFull()`
 * goes through keepNumbersWhole(); as an attribute value (title, aria-label)
 * it stays a plain string. The other date methods (date, dayKey, month,
 * relative, dateDivider) put no punctuation inside a number next to Hangul.
 */
const DATE_TIME_METHODS = ["time", "dateTime", "dateTimeFull"];

/** The shared formatter in a file: `fmt`, a direct call, or any `const x = useFormat() / appFormat()`. */
const formatterReceivers = (source: string) => [
  ...new Set([
    "fmt",
    "appFormat\\(\\s*\\)",
    "useFormat\\(\\s*\\)",
    ...[...source.matchAll(/\bconst\s+(\w+)\s*=\s*(?:useFormat|appFormat)\(\s*\)/g)].map((m) => m[1]!),
  ]),
];

/** JSX children that render a date-time formatter result directly. */
const bareDateTimeChildren = (source: string) => {
  const receiver = formatterReceivers(source).join("|");
  const bareChild = new RegExp(`(?<![=\\w$])\\{\\s*(?:${receiver})\\s*\\.\\s*(?:${DATE_TIME_METHODS.join("|")})\\s*\\(`, "g");
  return [...source.matchAll(bareChild)].map((m) => m[0]);
};

describe("date and time formatters render through keepNumbersWhole()", () => {
  it.each([
    ["<p>{fmt.time(ts)}</p>", 1],
    ["<span>{ fmt . dateTime (ts) }</span>", 1],
    ["<div>\n  {fmt.dateTimeFull(stats.first)}\n</div>", 1],
    ["const date = appFormat();\n<p>{date.time(ts)}</p>", 1],
    ["<p>{appFormat().dateTime(ts)}</p>", 1],
    ["<span>{fmt.time(a)}  •  {fmt.date(a, \"short\")}</span>", 1],
    ["<p>{keepNumbersWhole(fmt.time(ts))}</p>", 0],
    ['<span title={fmt.dateTimeFull(ts)} aria-label={fmt.time(ts)}>x</span>', 0],
    ["const label = `${fmt.time(ts)}`;", 0],
    ["<p>{fmt.date(ts, \"short\")} {fmt.relative(ts)} {fmt.dateDivider(ts)}</p>", 0],
    ["<p>{timer.time(ts)}</p>", 0],
  ])("fixture %j: %i bare child(ren)", (source, count) => {
    expect(bareDateTimeChildren(source)).toHaveLength(count);
  });

  it("no component renders one bare", () => {
    const src = resolve(__dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".tsx") && !/\.test\.tsx$/.test(path)) files.push(path);
      }
    };
    walk(src);
    const bare = files.flatMap((file) => bareDateTimeChildren(readFileSync(file, "utf8")).map((hit) => `${relative(src, file)}: ${hit}`));
    expect(files.length).toBeGreaterThan(100);
    expect(bare).toEqual([]);
  });
});
