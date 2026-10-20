/**
 * Guard: every formatter result shown as text renders through <Num>
 * (inner-UI plan F1b; Num.tsx says why).
 *
 * A formatter result is a call of a shared formatter: `fmt.tokens(n)`,
 * `appFormat().bytes(b)`, `useFormat().time(ts)`, any `const x =
 * useFormat() | appFormat() | formatterFor(…)` (`x.count(n)`, or destructured
 * `const { count } = …`), and the module functions (`formatBytes(…)`). The
 * methods are read from `formatterFor()` itself, so a new one is covered.
 * Its text flows on through `?:`, `&&`, `||`, `??`, `+`, a template, `.text`
 * (of `change`), a `const`, `useMemo`, `.map`, a function that returns it (in
 * the same file or imported from another), and a message that interpolates
 * it (`t("key", { n: fmt.count(x) })`).
 *
 * Reported: such text rendered as a bare JSX child (or as a component's whole
 * output). Allowed: inside `<Num>`; inside SVG `<text>` / `<tspan>`, which
 * never wraps; in an attribute of a DOM element (`title`, `aria-label`) or
 * any call other than `t()` (data, a toast). Handed to a component prop or an
 * object field, it is listed in HANDOFFS below: each receiver renders it
 * through <Num>, and a new handoff is a reviewed change here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as dateModule from "./date";
import * as durationModule from "./duration";
import * as numberModule from "./number";
import { formatterFor } from "./useFormat";

const ROOT = resolve(__dirname, "../../..");
const SRC = join(ROOT, "src");

const sample = formatterFor("en");
const FORMATTER_METHODS = new Set(
  Object.keys(sample).filter((key) => typeof sample[key as keyof typeof sample] === "function"),
);
const FORMAT_FUNCTIONS = new Set(
  [numberModule, dateModule, durationModule].flatMap((module) =>
    Object.entries(module)
      .filter(([name, value]) => typeof value === "function" && /^format[A-Z]/.test(name))
      .map(([name]) => name),
  ),
);
const FORMATTER_FACTORIES = new Set(["useFormat", "appFormat", "formatterFor"]);
/** SVG text never wraps, so a number there cannot split. */
const NEVER_WRAPS = new Set(["text", "tspan", "textPath"]);

export interface SourceFile {
  /** Repo path with `/` (`src/components/X.tsx`). */
  path: string;
  text: string;
}

export interface NumScan {
  /** `path:line: code` of every formatter result rendered bare. */
  bare: string[];
  /** `path: Component.prop` / `path: field name` of every handoff. */
  handoffs: string[];
  /** The bare JSX children themselves (`{…}`), by file and offset. */
  sites: { path: string; start: number; end: number }[];
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isTypeAssertionExpression(node)
    ? unwrap(node.expression)
    : node;

const isWrapper = (node: ts.Node) =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node) ||
  ts.isTypeAssertionExpression(node);

const isFunctionLike = (node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration =>
  ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);

const tagName = (node: ts.JsxElement | ts.JsxOpeningLikeElement) =>
  (ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName).getText();

const isComponentTag = (name: string) => /^[A-Z]/.test(name) || name.includes(".");

/** Where a value ends up after the expressions that pass it on unchanged (or keep it as text). */
function valueEnd(node: ts.Node): { child: ts.Node; parent: ts.Node } {
  let child = node;
  let parent = node.parent;
  for (;;) {
    if (isWrapper(parent)) {
      [child, parent] = [parent, parent.parent];
      continue;
    }
    if (ts.isConditionalExpression(parent) && parent.condition !== child) {
      [child, parent] = [parent, parent.parent];
      continue;
    }
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      const passes =
        (op === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child) ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken;
      if (passes) {
        [child, parent] = [parent, parent.parent];
        continue;
      }
    }
    if (ts.isTemplateSpan(parent) && parent.expression === child) {
      [child, parent] = [parent.parent, parent.parent.parent];
      continue;
    }
    return { child, parent };
  }
}

/** The repo path a module specifier names, if it is one of `known`. */
function resolveImport(from: string, specifier: string, known: ReadonlySet<string>): string | undefined {
  let base: string;
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) base = join(dirname(from), specifier).split(sep).join("/");
  else return undefined;
  return ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((path) => known.has(path));
}

interface FileState {
  file: SourceFile;
  sf: ts.SourceFile;
  /** Identifiers that hold a formatter (`fmt`, `const f = appFormat()`). */
  receivers: Set<string>;
  /** Functions whose result is formatter text (destructured methods, helpers, imports). */
  functions: Set<string>;
  /** Exported helpers that return formatter text. */
  exported: Set<string>;
}

export function scanNum(files: readonly SourceFile[]): NumScan {
  const known = new Set(files.map((f) => f.path));
  const states = files.map((file): FileState => {
    const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file.path, file.text.replace(/\r\n/g, "\n"), ts.ScriptTarget.Latest, true, kind);
    return { file, sf, receivers: new Set(["fmt"]), functions: new Set(FORMAT_FUNCTIONS), exported: new Set() };
  });
  const byPath = new Map(states.map((s) => [s.file.path, s]));

  // Formatter bindings: `const f = useFormat()`, `const { count, tokens: tk } = appFormat()`.
  for (const state of states) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = unwrap(node.initializer);
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && FORMATTER_FACTORIES.has(init.expression.text)) {
          if (ts.isIdentifier(node.name)) state.receivers.add(node.name.text);
          else if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              const method = (element.propertyName ?? element.name).getText(state.sf);
              if (FORMATTER_METHODS.has(method) && ts.isIdentifier(element.name)) state.functions.add(element.name.text);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(state.sf);
  }

  const bare = new Map<string, string>();
  const handoffs = new Set<string>();
  const sites = new Map<string, NumScan["sites"][number]>();
  let changed = true;

  const isFormatterText = (state: FileState, node: ts.Node): boolean => {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee)) return state.functions.has(callee.text);
    if (!ts.isPropertyAccessExpression(callee) || !FORMATTER_METHODS.has(callee.name.text)) return false;
    const receiver = unwrap(callee.expression);
    if (ts.isIdentifier(receiver)) return state.receivers.has(receiver.text);
    return ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression) && FORMATTER_FACTORIES.has(receiver.expression.text);
  };

  const report = (state: FileState, at: ts.Node) => {
    const { line } = state.sf.getLineAndCharacterOfPosition(at.getStart(state.sf));
    const code = state.sf.text.split("\n")[line]!.trim();
    bare.set(`${state.file.path}:${at.getStart(state.sf)}`, `${state.file.path}:${line + 1}: ${code}`);
  };

  /** Every identifier `name` used as a value inside `scope`. */
  const references = (scope: ts.Node, name: string, declaration: ts.Node): ts.Identifier[] => {
    const out: ts.Identifier[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name && node !== declaration) {
        const p = node.parent;
        const isName =
          (ts.isPropertyAccessExpression(p) && p.name === node) ||
          (ts.isPropertyAssignment(p) && p.name === node) ||
          ts.isJsxAttribute(p) ||
          (ts.isVariableDeclaration(p) && p.name === node) ||
          ts.isBindingElement(p) ||
          ts.isParameter(p);
        if (!isName) out.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(scope);
    return out;
  };

  const seen = new Set<ts.Node>();
  /**
   * Follow formatter text from `source` to where it ends. `inMessage`: the
   * text is a message that holds a formatter result (`t("key", { n: … })`);
   * it must render through <Num> as text, and is no handoff elsewhere.
   */
  const follow = (state: FileState, source: ts.Node, inMessage = false): void => {
    if (seen.has(source)) return;
    seen.add(source);
    let { child, parent } = valueEnd(source);
    // `fmt.change(a, b).text`
    while (ts.isPropertyAccessExpression(parent) && parent.expression === child && parent.name.text === "text") {
      ({ child, parent } = valueEnd(parent));
    }
    if (ts.isJsxExpression(parent)) {
      const host = parent.parent;
      if (ts.isJsxElement(host) || ts.isJsxFragment(host)) {
        const tag = ts.isJsxElement(host) ? tagName(host) : "";
        if (tag !== "Num" && !NEVER_WRAPS.has(tag)) {
          report(state, source);
          sites.set(`${state.file.path}:${parent.getStart(state.sf)}`, { path: state.file.path, start: parent.getStart(state.sf), end: parent.end });
        }
        return;
      }
      if (ts.isJsxAttribute(host) && !inMessage) {
        const element = host.parent.parent;
        const tag = tagName(element);
        if (isComponentTag(tag)) handoffs.add(`${state.file.path}: ${tag}.${host.name.getText(state.sf)}`);
      }
      return;
    }
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === child) {
      const list = parent.parent;
      if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const) {
        const scope = list.parent.parent;
        for (const ref of references(scope, parent.name.text, parent.name)) follow(state, ref, inMessage);
        if (isFunctionLike(unwrap(parent.initializer))) return;
      }
      return;
    }
    if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) {
      const call = parent.parent.parent;
      if (ts.isCallExpression(call)) {
        // A message that interpolates it (`t("key", { n: fmt.count(x) })`) is
        // text holding the number; any other call takes it as data.
        const callee = unwrap(call.expression);
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
        if (name === "t") follow(state, call, true);
        return;
      }
      if (inMessage) return;
      let holder: ts.Node = parent.parent;
      while (ts.isArrayLiteralExpression(holder.parent) || isWrapper(holder.parent)) holder = holder.parent;
      const field = parent.name.getText(state.sf);
      if (ts.isJsxExpression(holder.parent) && ts.isJsxAttribute(holder.parent.parent)) {
        const attribute = holder.parent.parent;
        handoffs.add(`${state.file.path}: ${tagName(attribute.parent.parent)}.${attribute.name.getText(state.sf)}`);
      } else {
        handoffs.add(`${state.file.path}: field ${field}`);
      }
      return;
    }
    const fn = ts.isReturnStatement(parent)
      ? ts.findAncestor(parent, isFunctionLike)
      : ts.isArrowFunction(parent) && parent.body === child
        ? parent
        : undefined;
    if (!fn) return;
    // The function itself, or the useCallback(fn) that holds it.
    let holder: ts.Node = fn;
    const call = fn.parent;
    if (ts.isCallExpression(call) && call.arguments[0] === fn) {
      const callee = unwrap(call.expression);
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      // useMemo(() => text) is text; items.map((i) => text) renders as text nodes.
      if (["useMemo", "map", "flatMap"].includes(name)) return follow(state, call, inMessage);
      if (name !== "useCallback") return;
      holder = call;
    }
    const named = ts.isFunctionDeclaration(fn)
      ? fn.name
      : ts.isVariableDeclaration(holder.parent)
        ? holder.parent.name
        : undefined;
    if (!named || !ts.isIdentifier(named)) return;
    if (/^[A-Z]/.test(named.text)) {
      // A component whose output is the text itself.
      report(state, source);
      return;
    }
    if (!state.functions.has(named.text)) {
      state.functions.add(named.text);
      changed = true;
    }
    const statement = ts.isFunctionDeclaration(fn) ? fn : holder.parent.parent.parent;
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && !state.exported.has(named.text)) {
      state.exported.add(named.text);
      changed = true;
    }
  };

  while (changed) {
    changed = false;
    // Helpers imported from a file that returns formatter text.
    for (const state of states) {
      for (const statement of state.sf.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const target = resolveImport(state.file.path, statement.moduleSpecifier.text, known);
        const bindings = statement.importClause?.namedBindings;
        if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (byPath.get(target)!.exported.has(imported) && !state.functions.has(element.name.text)) {
            state.functions.add(element.name.text);
            changed = true;
          }
        }
      }
    }
    seen.clear();
    for (const state of states) {
      const visit = (node: ts.Node): void => {
        if (isFormatterText(state, node)) follow(state, node);
        ts.forEachChild(node, visit);
      };
      visit(state.sf);
    }
  }
  return { bare: [...bare.values()], handoffs: [...handoffs].sort(), sites: [...sites.values()] };
}

// ---------------------------------------------------------------------------

/**
 * Every formatter result the app hands to a component prop or an object
 * field, and so renders where it arrives. A new entry is a reviewed change:
 * route the text through <Num> where it is rendered and name that place in
 * RECEIVERS.
 */
const HANDOFFS = [
  "src/components/AnalyticsDashboard/components/ActivityHeatmap.tsx: ChartTooltip.rows",
  "src/components/AnalyticsDashboard/components/ActivityHeatmap.tsx: ChartTooltip.title",
  "src/components/AnalyticsDashboard/components/DailyTrendChart.tsx: ChartTooltip.rows",
  "src/components/AnalyticsDashboard/components/DailyTrendChart.tsx: ChartTooltip.title",
  "src/components/AnalyticsDashboard/components/TokenDistributionChart.tsx: ChartTooltip.rows",
  "src/components/AnalyticsDashboard/views/GlobalStatsView.tsx: MetricCard.subValue",
  "src/components/AnalyticsDashboard/views/GlobalStatsView.tsx: MetricCard.value",
  "src/components/AnalyticsDashboard/views/ProjectStatsView.tsx: MetricCard.subValue",
  "src/components/AnalyticsDashboard/views/ProjectStatsView.tsx: MetricCard.value",
  "src/components/Inspector/InspectorTokensTab.tsx: MetricRow.detail",
  "src/components/Inspector/InspectorTokensTab.tsx: MetricRow.value",
  "src/components/ProjectTree/components/LibrarySection.tsx: field caption",
  "src/components/SessionBoard/ContributionGrid.tsx: ChartTooltip.title",
];

/** Where each handoff is rendered: the receiver's file and its JSX child `{…}` that shows it. */
const RECEIVERS: Record<string, [file: string, child: string]> = {
  "ChartTooltip.rows": ["src/components/ui/chart-tooltip.tsx", "String(row.value)"],
  "ChartTooltip.title": ["src/components/ui/chart-tooltip.tsx", "title"],
  "MetricCard.value": ["src/components/AnalyticsDashboard/components/MetricCard.tsx", "String(value)"],
  "MetricCard.subValue": ["src/components/AnalyticsDashboard/components/MetricCard.tsx", "subValue"],
  "MetricRow.value": ["src/components/Inspector/InspectorTokensTab.tsx", "value"],
  "MetricRow.detail": ["src/components/Inspector/InspectorTokensTab.tsx", "detail"],
  "field caption": ["src/components/ProjectTree/components/LibrarySection.tsx", "entry.caption"],
};

/** The tags of the JSX elements whose child `{…}` is exactly `child`, in `file`. */
function hostsOf(file: SourceFile, child: string): string[] {
  const sf = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && node.expression && node.expression.getText(sf).replace(/\s+/g, "") === child) {
      if (ts.isJsxElement(node.parent)) out.push(tagName(node.parent));
      else if (ts.isJsxFragment(node.parent)) out.push("<>");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const isTest = (path: string) =>
  /\.test\.tsx?$/.test(path) || path.includes(`${sep}__tests__${sep}`) || path.includes(`${sep}test${sep}`);

function appSources(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts") && !isTest(path)) {
        out.push({ path: relative(ROOT, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(SRC);
  return out;
}

let appScan: NumScan | undefined;
const scanApp = () => (appScan ??= scanNum(appSources()));

/** Bare lines (1-based) for one in-memory `.tsx` file, plus optional others. */
const bareLines = (code: string, others: SourceFile[] = []) =>
  scanNum([{ path: "src/components/Probe.tsx", text: code }, ...others])
    .bare.filter((hit) => hit.startsWith("src/components/Probe.tsx:"))
    .map((hit) => Number(hit.split(":")[1]));

describe("<Num> guard: the formatter methods it knows", () => {
  it("reads every text method from formatterFor() and the format* functions from the modules", () => {
    expect([...FORMATTER_METHODS]).toEqual(expect.arrayContaining(["number", "tokens", "cost", "percent", "bytes", "duration", "time", "dateTime", "dayKey", "change"]));
    expect(FORMATTER_METHODS.has("language")).toBe(false);
    expect([...FORMAT_FUNCTIONS]).toEqual(expect.arrayContaining(["formatNumber", "formatBytes", "formatTime", "formatDuration", "formatDateDivider"]));
  });
});

describe("<Num> guard: a formatter result rendered bare is found", () => {
  it.each([
    ["a call as a child", "const A = () => <p>{fmt.count(n)}</p>;"],
    ["spaced out", "const A = () => <span>{ fmt . tokens (n) }</span>;"],
    ["a branch of ?:", 'const A = () => <p>{ok ? fmt.cost(c) : "—"}</p>;'],
    ["after &&", "const A = () => <p>{ok && fmt.percent(r)}</p>;"],
    ["either side of ?? and ||", 'const A = () => <p>{fmt.bytes(b) ?? "-"}{fmt.bytes(b) || "-"}</p>;'],
    ["in a template", "const A = () => <p>{`${fmt.tokens(a)} / total`}</p>;"],
    ["in a concatenation", 'const A = () => <p>{"~" + fmt.cost(c)}</p>;'],
    ["change().text", "const A = () => <p>{fmt.change(a, b).text}</p>;"],
    ["a cast", "const A = () => <p>{(fmt.count(n) as string)}</p>;"],
    ["a fragment", "const A = () => <>{fmt.count(n)}</>;"],
    ["a custom element's child", "const A = () => <Badge>{fmt.bytes(b)}</Badge>;"],
    ["an alias of appFormat()", "const date = appFormat();\nconst A = () => <p>{date.time(ts)}</p>;"],
    ["appFormat() directly", "const A = () => <p>{appFormat().dateTime(ts)}</p>;"],
    ["useFormat() directly", "const A = () => <p>{useFormat().minutes(m)}</p>;"],
    ["formatterFor()", 'const f = formatterFor("ko");\nconst A = () => <p>{f.number(n)}</p>;'],
    ["a destructured method", "const { tokens: tk } = useFormat();\nconst A = () => <p>{tk(n)}</p>;"],
    ["a module function", 'const A = () => <p>{formatBytes(b, "ko")}</p>;'],
    ["a const", "function A() {\n  const label = fmt.count(n);\n  return <p>{label}</p>;\n}"],
    ["a const of a const", "function A() {\n  const a = fmt.count(n);\n  const b = ok ? a : \"—\";\n  return <p>{b}</p>;\n}"],
    ["useMemo", "function A() {\n  const label = useMemo(() => fmt.dateTime(ts), [ts]);\n  return <p>{label}</p>;\n}"],
    ["a helper", "const elapsed = (ms: number) => fmt.duration(ms);\nconst A = () => <p>{elapsed(ms)}</p>;"],
    ["a function", "function stamp(ts: string) {\n  return fmt.time(ts);\n}\nconst A = () => <p>{stamp(ts)}</p>;"],
    ["map", "const A = () => <p>{items.map((i) => fmt.count(i))}</p>;"],
    ["a component that renders only the text", "const Total = () => fmt.count(n);"],
    ["a message that interpolates it", 'const A = () => <p>{t("k", { count: fmt.count(n) })}</p>;'],
    ["a message with a default text", 'const A = () => <p>{t("k", "{{n}} msgs", { n: fmt.count(n) })}</p>;'],
    ["a message held in a const", 'function A() {\n  const meta = i18n.t("k", { date: fmt.dateTime(ts) });\n  return <p>{meta}</p>;\n}'],
  ])("%s", (_, code) => {
    expect(bareLines(code).length, code).toBeGreaterThan(0);
  });

  it("reports each site on its own line, also across lines", () => {
    expect(bareLines("const A = () => (\n  <div>\n    <span>\n      {fmt.time(ts)}\n    </span>\n    {fmt.date(ts)}\n  </div>\n);")).toEqual([4, 6]);
    expect(bareLines("const A = () => <p>{`${fmt.tokens(a)} / ${fmt.tokens(b)}`}</p>;")).toEqual([1, 1]);
  });

  it("follows a helper exported by another file", () => {
    const utils = { path: "src/components/utils.ts", text: "export const clock = (ts: string) => appFormat().time(ts);\nexport function day(ts: string) { return appFormat().date(ts); }" };
    expect(bareLines('import { clock, day as d } from "./utils";\nconst A = () => <p>{clock(ts)} {d(ts)}</p>;', [utils])).toEqual([2, 2]);
    const viaAlias = { path: "src/lib/stamp.ts", text: "export const stamp = (ts: string) => appFormat().time(ts);" };
    expect(bareLines('import { stamp } from "@/lib/stamp";\nconst A = () => <p>{stamp(ts)}</p>;', [viaAlias])).toEqual([2]);
  });
});

describe("<Num> guard: not reported", () => {
  it.each([
    ["inside <Num>", "const A = () => <p><Num>{fmt.count(n)}</Num></p>;"],
    ["a branch inside <Num>", 'const A = () => <Num>{ok ? fmt.cost(c) : t("x")}</Num>;'],
    ["a const inside <Num>", "function A() {\n  const label = fmt.count(n);\n  return <Num>{label}</Num>;\n}"],
    ["attributes of a DOM element", "const A = () => <span title={fmt.dateTimeFull(ts)} aria-label={fmt.time(ts)}>x</span>;"],
    ["a const used as an attribute", "function A() {\n  const label = fmt.count(n);\n  return <p title={label}>x</p>;\n}"],
    ["a message as an attribute", 'const A = () => <p title={t("k", { count: fmt.count(n) })}>x</p>;'],
    ["a message as data", 'const preset = { name: t("k", { date: appFormat().date(now) }) };\nsave(t("k", { size: fmt.bytes(b) }));'],
    ["another call", "toast(fmt.bytes(b));"],
    ["SVG text, which never wraps", "const A = () => <svg><text>{fmt.dayKey(d)}</text><tspan>{fmt.count(n)}</tspan></svg>;"],
    ["not a formatter", "const A = () => <p>{timer.time(ts)}{fmt.language}</p>;"],
    ["change().direction", "const A = () => <p>{fmt.change(a, b).direction}</p>;"],
    ["a condition", 'const A = () => <p>{fmt.count(n) === "0" ? "none" : "some"}</p>;'],
    ["a helper used as an attribute", "const clock = (ts: string) => fmt.time(ts);\nconst A = () => <p title={clock(ts)}>x</p>;"],
  ])("%s", (_, code) => {
    expect(bareLines(code), code).toEqual([]);
  });
});

describe("<Num> guard: handoffs to a component or an object field are listed", () => {
  it("names the component prop or the field", () => {
    const scan = scanNum([
      {
        path: "src/components/Probe.tsx",
        text: [
          "const A = () => <MetricCard value={fmt.tokens(n)} />;",
          'const B = () => <ChartTooltip rows={[{ label: "a", value: fmt.count(n) }]} />;',
          "const items = [{ caption: fmt.relative(ts) }];",
          "const C = () => <ui.Row detail={ok ? fmt.cost(c) : undefined} />;",
        ].join("\n"),
      },
    ]);
    expect(scan.bare).toEqual([]);
    expect(scan.handoffs).toEqual([
      "src/components/Probe.tsx: ChartTooltip.rows",
      "src/components/Probe.tsx: MetricCard.value",
      "src/components/Probe.tsx: field caption",
      "src/components/Probe.tsx: ui.Row.detail",
    ]);
  });
});

describe("<Num> guard on the app", () => {
  it("scans the source tree", () => {
    expect(appSources().length).toBeGreaterThan(300);
  });

  it("no formatter result is rendered bare", () => {
    expect(scanApp().bare).toEqual([]);
  }, 30_000);

  it("every handoff to a component or an object field is listed (its receiver renders it through <Num>)", () => {
    expect(scanApp().handoffs).toEqual(HANDOFFS);
  }, 30_000);

  it("each receiver renders the handed-over text inside <Num>", () => {
    const files = new Map(appSources().map((f) => [f.path, f]));
    const keys = new Set(HANDOFFS.map((h) => h.split(": ")[1]!));
    expect([...keys].sort()).toEqual(Object.keys(RECEIVERS).sort());
    for (const key of keys) {
      const [file, child] = RECEIVERS[key]!;
      const hosts = hostsOf(files.get(file)!, child);
      expect(hosts.length, `${key}: {${child}} in ${file}`).toBeGreaterThan(0);
      expect(hosts, `${key}: {${child}} in ${file}`).toEqual(hosts.map(() => "Num"));
    }
  });

  it("finds a receiver that renders the text bare (fixture)", () => {
    const receiver = { path: "src/components/X.tsx", text: "const X = ({ value }) => <div><span>{value}</span><Num>{ value }</Num></div>;" };
    expect(hostsOf(receiver, "value")).toEqual(["span", "Num"]);
  });
});
