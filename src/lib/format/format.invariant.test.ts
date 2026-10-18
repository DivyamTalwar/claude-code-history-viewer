/**
 * Guard: numbers, dates and durations are formatted only in `src/lib/format`.
 *
 * Outside this module no code calls `Intl.*` or `toLocale*()` (those read the
 * OS locale unless a locale is passed), and no file defines its own
 * `formatNumber` / `formatDuration` / `formatCurrency` / `formatCost` /
 * `formatTokens` / `formatPercent`. One implementation each (plan D15).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SRC = join(ROOT, "src");
const MODULE_DIR = join(SRC, "lib", "format") + sep;

const isTest = (path: string) =>
  /\.test\.tsx?$/.test(path) || path.includes(`${sep}__tests__${sep}`) || path.includes(`${sep}test${sep}`);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

const stripComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function findings(pattern: RegExp): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file.startsWith(MODULE_DIR) || isTest(file)) continue;
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line)) out.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe("format module invariant", () => {
  it("scans the source tree", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(300);
  });

  it("has no Intl.* or toLocale*() call outside src/lib/format", () => {
    expect(findings(/\bIntl\.|\.toLocale(String|DateString|TimeString)\(/)).toEqual([]);
  });

  it("has one implementation of each number / duration formatter", () => {
    expect(
      findings(
        /\b(function|const|let)\s+format(Number|Duration\w*|Currency|Cost|Tokens|Percent|Bytes|DateCompact|TimeShort|TimeAgo|DateDivider)\s*[=(:]/,
      ),
    ).toEqual([]);
  });

  it("has no hand-built day key from a UTC ISO string", () => {
    expect(findings(/toISOString\(\)\.(slice|split|substring)\(/)).toEqual([]);
  });
});
