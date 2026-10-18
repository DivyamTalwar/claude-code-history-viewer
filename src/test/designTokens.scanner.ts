import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";
import postcss from "postcss";
import ts from "typescript";

/**
 * Design-token guard scanner (inner-UI plan I0b, §4.5).
 *
 * Every finding is one fingerprint:
 *
 *   `${file}|${category}|${hash(normalized snippet)}|${n}`
 *
 * where `n` numbers equal snippets of the same category inside one file.
 * Line numbers are not part of it, so edits elsewhere in a file do not churn
 * the baseline; a moved or renamed file, a new file, a different snippet
 * (same-count swap) or one more copy of a snippet are all new fingerprints.
 *
 * Fifteen categories (`CATEGORIES`). Class names are folded with the
 * TypeScript checker the same way as typography.guard.test.ts (strings,
 * templates, conditionals, constants); a colour/radius/shadow class the
 * checker cannot resolve (`bg-${tone}`) is its own category. Stylesheets are
 * read with postcss; custom property definitions (`--x: …`) are the token
 * layer and are not counted.
 */

export const CATEGORIES = [
  "palette",
  "hexRgb",
  "arbitraryColor",
  "textOpacity",
  "borderOpacity",
  "shadow",
  "motion",
  "zIndex",
  "uppercaseTracking",
  "monoUnmarked",
  "scale",
  "decoration",
  "radius",
  "spacing",
  "dynamicClass",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Finding {
  file: string;
  line: number;
  category: Category;
  snippet: string;
}

const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");

/** Standalone HTML documents the app writes (own stylesheet, no app tokens). */
export const EXEMPT_FILES = ["src/services/export/htmlExporter.ts"];

export const isTestFile = (relPath: string) =>
  /\.test\.(ts|tsx)$/.test(relPath) ||
  relPath.startsWith("src/test/") ||
  relPath.includes("__snapshots__") ||
  relPath.includes("__tests__");

// ---------------------------------------------------------------------------
// Class-token detectors
// ---------------------------------------------------------------------------

const PALETTE_HUES =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const COLOR_UTILITIES =
  "bg|text|border|border-[trblxyse]|ring|ring-offset|fill|stroke|from|via|to|outline|decoration|divide|placeholder|caret|accent|shadow|inset-shadow";
const PALETTE_RE = new RegExp(`^(?:${COLOR_UTILITIES})-(?:(?:${PALETTE_HUES})-\\d{2,3}|white|black)(?:/[\\w.[\\]]+)?$`);
const ARBITRARY_COLOR_RE = new RegExp(
  `^(?:${COLOR_UTILITIES})-(?:\\[(?:color:)?(?:#[\\da-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab|hwb|lab|lch|color-mix)\\(.*\\)|var\\(--(?!text-)[\\w-]+\\))\\]|\\((?:color:)?--(?!text-)[\\w-]+\\))(?:/[\\w.[\\]]+)?$`,
);
/** Semantic (token) colour names the app defines (bg-muted, text-accent, …). */
const TOKEN_COLOR_RE = /^[a-z][\w-]*$/;
const TEXT_STEPS = new Set(["caption", "list", "body", "code", "title", "lg", "xl", "2xl", "xs", "sm", "base", "3xl"]);
const TEXT_NON_COLOR = new Set(["left", "right", "center", "justify", "start", "end", "ellipsis", "clip", "wrap", "nowrap", "balance", "pretty"]);

/** The utility of a class token without variants (`md:`, `hover:`, `[&>p]:`) and `!`. */
export function utilityOf(token: string): string {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if ((c === "]" || c === ")") && depth > 0) depth--;
    else if (c === ":" && depth === 0) last = i;
  }
  return token.slice(last + 1).replace(/^!|!$/g, "");
}

const variantsOf = (token: string) => token.slice(0, token.length - utilityOf(token).length);

/** Allowed motion: D9 durations and the --ease-* tokens of index.css. */
export const ALLOWED_DURATIONS = new Set(["150", "250", "400"]);
let easeTokens: Set<string> | null = null;
function allowedEase(): Set<string> {
  if (!easeTokens) {
    const css = readFileSync(join(SRC, "index.css"), "utf8");
    easeTokens = new Set([...css.matchAll(/--ease-([\w-]+)\s*:/g)].map((m) => m[1] ?? ""));
  }
  return easeTokens;
}

/** Radius suffixes on the token scale: 6 (md), 8 (lg); full (pills, dots) and none. */
const ALLOWED_RADIUS = new Set(["md", "lg", "full", "none"]);

/** Categories of one class token (most tokens: none). */
export function classTokenCategories(token: string): Category[] {
  const u = utilityOf(token);
  const out: Category[] = [];
  if (PALETTE_RE.test(u)) out.push("palette");
  else if (ARBITRARY_COLOR_RE.test(u)) out.push("arbitraryColor");
  else {
    const text = /^text-([a-z][\w-]*)\/[\w.[\]]+$/.exec(u);
    if (text && !TEXT_STEPS.has(text[1] ?? "") && !TEXT_NON_COLOR.has(text[1] ?? "") && TOKEN_COLOR_RE.test(text[1] ?? "")) out.push("textOpacity");
    const border = /^border(?:-[trblxyse])?-([a-z][\w-]*)\/[\w.[\]]+$/.exec(u);
    if (border && TOKEN_COLOR_RE.test(border[1] ?? "")) out.push("borderOpacity");
  }
  if (/^shadow(?:-|$)/.test(u) && u !== "shadow-none" && !/^shadow-\[?(?:color:)?(?:#|var|rgb)/.test(u) && !PALETTE_RE.test(u)) out.push("shadow");
  const duration = /^duration-(.+)$/.exec(u);
  if (duration && !ALLOWED_DURATIONS.has(duration[1] ?? "")) out.push("motion");
  const ease = /^ease-(.+)$/.exec(u);
  if (ease && !allowedEase().has(ease[1] ?? "")) out.push("motion");
  if (/^z-\[.+\]$/.test(u)) out.push("zIndex");
  if (/^scale-/.test(u) && /(^|:)(hover|active|group-hover|focus):/.test(variantsOf(token))) out.push("scale");
  if (/^backdrop-blur/.test(u) || /^bg-(gradient|linear|radial|conic)-/.test(u)) out.push("decoration");
  const radius = /^rounded(?:-(?:[trblse]|tl|tr|br|bl|ss|se|es|ee))?(?:-(.+))?$/.exec(u);
  if (radius) {
    const size = radius[1] ?? "";
    if (size === "" || (!ALLOWED_RADIUS.has(size) && !/^\[var\(--radius-(?:md|lg)\)\]$/.test(size))) out.push("radius");
  }
  if (/^-?(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-\[(?!var\(--)[^\]]+\]$/.test(u)) out.push("spacing");
  return out;
}

/** Class-string level: `uppercase` + `tracking-*` together, colored icon boxes. */
export function classStringCategories(tokens: string[]): Array<{ category: Category; snippet: string }> {
  const utilities = tokens.map(utilityOf);
  const out: Array<{ category: Category; snippet: string }> = [];
  const tracking = utilities.find((u) => /^tracking-/.test(u));
  if (utilities.includes("uppercase") && tracking) out.push({ category: "uppercaseTracking", snippet: `uppercase ${tracking}` });
  // Coloured icon box: a fixed square, rounded, centred, on a tinted fill.
  const square = utilities.some((u) => /^size-(\d+|\[.+\])$/.test(u)) || (utilities.some((u) => /^w-\d+$/.test(u)) && utilities.some((u) => /^h-\d+$/.test(u)));
  const tinted = utilities.find((u) => /^bg-[a-z][\w-]*\/\d+$/.test(u) || (PALETTE_RE.test(u) && u.startsWith("bg-")));
  const centred = utilities.includes("items-center") && utilities.includes("justify-center");
  const rounded = utilities.some((u) => /^rounded/.test(u));
  if (square && tinted && centred && rounded) out.push({ category: "decoration", snippet: `icon box ${tinted}` });
  return out;
}

/** `bg-` / `text-` / `border-` / `shadow-` / `rounded-` followed by a value the checker cannot resolve. */
const UNKNOWN = "\u0000";
export function isDynamicStyleClass(token: string): boolean {
  if (!token.includes(UNKNOWN)) return false;
  const u = utilityOf(token.slice(0, token.indexOf(UNKNOWN)) + UNKNOWN);
  const prefix = /^(bg|text|border(?:-[trblxy])?|shadow|rounded(?:-[trbl])?)-\[?/.exec(u);
  return !!prefix && u.slice(prefix[0].length).startsWith(UNKNOWN);
}

// ---------------------------------------------------------------------------
// Value-level detectors (inline styles, CSS)
// ---------------------------------------------------------------------------

const HEX_RE = /(?<![\w&#-])#(?:[\da-fA-F]{8}|[\da-fA-F]{6}|[\da-fA-F]{4}|[\da-fA-F]{3})(?![\w-])/g;
const FN_COLOR_RE = /\b(?:rgba?|hsla?)\(\s*[\d.][^)]*\)/g;

/** Hex / rgb() / hsl() colour literals in a CSS-ish value (the whole literal is the snippet). */
export function colorLiterals(value: string): string[] {
  return [...(value.match(HEX_RE) ?? []), ...(value.match(FN_COLOR_RE) ?? []).map((m) => m.replace(/\s+/g, " "))];
}

const TIME_RE = /(?<![\w-])(\d*\.?\d+)(ms|s)\b/g;
/** Literal durations (not var(--duration-*)) outside the allowed set. */
export function offTokenDurations(value: string): string[] {
  const bad: string[] = [];
  for (const m of value.matchAll(TIME_RE)) {
    const ms = m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
    if (ms === 0) continue;
    if (!ALLOWED_DURATIONS.has(String(ms))) bad.push(`${m[1]}${m[2]}`);
  }
  return bad;
}

const normalize = (snippet: string) => snippet.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// TypeScript sources
// ---------------------------------------------------------------------------

type Value = string | number;
const MAX_ALTERNATIVES = 64;

/** Every value `expr` can take (unresolved parts become UNKNOWN with `partial`). */
function possibleValues(expr: ts.Expression, checker: ts.TypeChecker, partial = false): Value[] | null {
  const unknown = partial ? [UNKNOWN] : null;
  const product = (parts: Array<Value[] | null>): Value[] | null => {
    let acc: Value[] = [""];
    for (const part of parts) {
      if (!part) return null;
      acc = acc.flatMap((a) => part.map((b) => `${a}${b}`));
      if (acc.length > MAX_ALTERNATIVES) return unknown;
    }
    return acc;
  };
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr)) {
    return possibleValues(expr.expression, checker, partial);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isNumericLiteral(expr)) return [Number(expr.text)];
  if (ts.isTemplateExpression(expr)) {
    return product([[expr.head.text], ...expr.templateSpans.flatMap((span) => [possibleValues(span.expression, checker, partial) ?? unknown, [span.literal.text]])]);
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return product([possibleValues(expr.left, checker, partial) ?? unknown, possibleValues(expr.right, checker, partial) ?? unknown]);
  }
  if (ts.isConditionalExpression(expr)) {
    const a = possibleValues(expr.whenTrue, checker, partial);
    const b = possibleValues(expr.whenFalse, checker, partial);
    return a && b ? [...a, ...b] : unknown;
  }
  const type = checker.getTypeAtLocation(expr);
  const literals: Value[] = [];
  for (const member of type.isUnion() ? type.types : [type]) {
    if (member.isStringLiteral() || member.isNumberLiteral()) literals.push(member.value);
    else if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
    else return unknown;
  }
  return literals.length ? literals : unknown;
}

/** Components whose content is code/paths/keys/diffs: `font-mono` inside them is meaningful. */
export const MONO_CONTAINERS = new Set(["Code", "PathText", "Kbd", "DiffView", "OutputBlock"]);
export const MONO_MARKERS = new Set(["code", "path", "id", "kbd", "diag"]);

function jsxTagName(node: ts.JsxOpeningLikeElement): string {
  const tag = node.tagName;
  return ts.isIdentifier(tag) ? tag.text : ts.isPropertyAccessExpression(tag) ? tag.name.text : tag.getText();
}

function monoExempt(node: ts.Node): boolean {
  // The element whose className this string belongs to.
  let attr: ts.Node | undefined = node;
  while (attr && !(ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name) && (attr.name.text === "className" || attr.name.text === "class"))) {
    if (ts.isSourceFile(attr) || ts.isFunctionLike(attr)) return false;
    attr = attr.parent;
  }
  if (!attr) return false;
  const opening = attr.parent?.parent;
  if (!opening || !(ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))) return false;
  const marker = opening.attributes.properties.find((p) => ts.isJsxAttribute(p) && ts.isIdentifier(p.name) && p.name.text === "data-mono");
  if (marker && ts.isJsxAttribute(marker) && marker.initializer && ts.isStringLiteral(marker.initializer) && MONO_MARKERS.has(marker.initializer.text)) return true;
  // An ancestor element that is a mono container.
  for (let n: ts.Node | undefined = opening.parent; n && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isJsxElement(n) && MONO_CONTAINERS.has(jsxTagName(n.openingElement))) return true;
  }
  return false;
}

/** Findings of one TS(X) file of a program. */
export function scanProgramFile(file: ts.SourceFile, checker: ts.TypeChecker, fileName: string): Finding[] {
  const findings: Finding[] = [];
  const report = (node: ts.Node, category: Category, snippet: string) => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    findings.push({ file: fileName, line, category, snippet: normalize(snippet) });
  };

  const checkClassText = (text: string, node: ts.Node) => {
    const tokens = text.split(/[\s"'`{}]+/).filter(Boolean);
    const seen = new Set<string>();
    for (const token of tokens) {
      if (token.includes(UNKNOWN)) {
        if (isDynamicStyleClass(token)) report(node, "dynamicClass", token.replaceAll(UNKNOWN, "${…}"));
        continue;
      }
      for (const category of classTokenCategories(token)) {
        const key = `${category}:${token}`;
        if (seen.has(key)) continue; // a token repeated in one string is one finding
        seen.add(key);
        report(node, category, token);
      }
      if (utilityOf(token) === "font-mono" && !monoExempt(node)) report(node, "monoUnmarked", token);
    }
    for (const { category, snippet } of classStringCategories(tokens.filter((t) => !t.includes(UNKNOWN)))) report(node, category, snippet);
    // Colour literals outside class tokens (constants, style strings, SVG attributes).
    const arbitrary = new Set(tokens.filter((t) => ARBITRARY_COLOR_RE.test(utilityOf(t)) || /\[(?:#|rgb|hsl)/.test(t)));
    const rest = tokens.filter((t) => !arbitrary.has(t)).join(" ");
    for (const literal of colorLiterals(rest)) report(node, "hexRgb", literal);
    // CSS written inside a string.
    for (const m of text.matchAll(/(?<![\w-])box-shadow\s*:\s*([^;"'`}]+)/g)) {
      const v = (m[1] ?? "").trim();
      if (v !== "none" && !/^var\(--shadow-/.test(v)) report(node, "shadow", `box-shadow: ${v}`);
    }
    for (const m of text.matchAll(/(?<![\w-])(?<!repeating-)(linear|radial|conic)-gradient\(/g)) report(node, "decoration", `${m[1]}-gradient(…)`);
  };

  const isPartOfLargerString = (node: ts.Node): boolean => {
    const parent = node.parent;
    return (
      (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      ts.isTemplateSpan(parent) ||
      (ts.isParenthesizedExpression(parent) && isPartOfLargerString(parent))
    );
  };

  const propName = (name: ts.PropertyName): string | null =>
    ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;

  /** Inline style values: `{ boxShadow: "…", transition: "…", borderRadius: 12, zIndex: … }`. */
  const checkStyleProperty = (name: string, value: ts.Expression, node: ts.Node) => {
    const values = possibleValues(value, checker);
    const shown = values ?? [value.getText(file)];
    for (const v of shown) {
      const s = String(v);
      if (name === "boxShadow" && s !== "none" && !/^var\(--shadow-/.test(s)) report(node, "shadow", `boxShadow: ${s}`);
      if (/^(transition|transitionDuration|animation|animationDuration)$/.test(name)) {
        for (const d of offTokenDurations(s)) report(node, "motion", `${name}: ${d}`);
      }
      if (name === "borderRadius" && !/^var\(--radius-(md|lg|full)\)$/.test(s) && s !== "0" && s !== "inherit") report(node, "radius", `borderRadius: ${s}`);
      if (name === "backdropFilter" || ((name === "background" || name === "backgroundImage") && /gradient\(/.test(s) && !/repeating-/.test(s))) {
        report(node, "decoration", `${name}: ${s.replace(/\(.*$/, "(…)")}`);
      }
    }
  };

  /** A literal folded into an enclosing template / `+` chain (scanned there, not twice). */
  const isInsideFoldedString = (node: ts.Node): boolean => {
    let child: ts.Node = node;
    let parent = node.parent;
    while (
      parent &&
      (ts.isParenthesizedExpression(parent) ||
        ts.isAsExpression(parent) ||
        (ts.isConditionalExpression(parent) && child !== parent.condition) ||
        (ts.isBinaryExpression(parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(parent.operatorToken.kind)))
    ) {
      child = parent;
      parent = parent.parent;
    }
    return !!parent && (ts.isTemplateSpan(parent) || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken));
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      // Import specifiers and type-only positions are never style text.
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent) && !ts.isLiteralTypeNode(node.parent) && !isInsideFoldedString(node)) checkClassText(node.text, node);
    } else if ((ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) && !isPartOfLargerString(node)) {
      const values = possibleValues(node, checker, true) ?? [UNKNOWN];
      const strings = values.filter((v): v is string => typeof v === "string");
      // Fold alternatives: report each distinct finding once per expression.
      const before = findings.length;
      for (const v of strings) checkClassText(v, node);
      const added = findings.splice(before);
      const unique = new Map(added.map((f) => [`${f.category}|${f.snippet}`, f]));
      findings.push(...unique.values());
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propName(node.name);
      if (name && /^(boxShadow|transition|transitionDuration|animation|animationDuration|borderRadius|backdropFilter|background|backgroundImage)$/.test(name)) checkStyleProperty(name, node.initializer, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

// ---------------------------------------------------------------------------
// Stylesheets
// ---------------------------------------------------------------------------

export function scanStylesheet(css: string, fileName: string): Finding[] {
  const findings: Finding[] = [];
  const root = postcss.parse(css, { from: fileName });
  const push = (node: postcss.Node, category: Category, snippet: string) =>
    findings.push({ file: fileName, line: node.source?.start?.line ?? 0, category, snippet: normalize(snippet) });
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--")) return; // the token layer itself
    const value = decl.value;
    for (const literal of colorLiterals(value)) push(decl, "hexRgb", `${decl.prop}: ${literal}`);
    if (decl.prop === "box-shadow" && value.trim() !== "none" && !/^var\(--shadow-[\w-]+\)$/.test(value.trim())) push(decl, "shadow", `box-shadow: ${value}`);
    if (/^(transition|transition-duration|animation|animation-duration)$/.test(decl.prop)) {
      for (const d of offTokenDurations(value)) push(decl, "motion", `${decl.prop}: ${d}`);
    }
    if (decl.prop === "z-index" && /^-?\d+$/.test(value.trim()) && Number(value) > 1) push(decl, "zIndex", `z-index: ${value}`);
    if (/^border(-[a-z]+)*-radius$/.test(decl.prop) && !/^(0|var\(--radius(-(md|lg|full))?\)|inherit)(\s*!important)?$/.test(value.trim())) push(decl, "radius", `${decl.prop}: ${value}`);
    if (/(?<!repeating-)(linear|radial|conic)-gradient\(/.test(value)) push(decl, "decoration", `${decl.prop}: gradient`);
    if (/^(-webkit-)?backdrop-filter$/.test(decl.prop) && value.trim() !== "none") push(decl, "decoration", `${decl.prop}: ${value}`);
  });
  root.walkAtRules("apply", (rule) => {
    const tokens = rule.params.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      for (const category of classTokenCategories(token)) push(rule, category, `@apply ${token}`);
    }
    for (const { category, snippet } of classStringCategories(tokens)) push(rule, category, `@apply ${snippet}`);
  });
  return findings;
}

// ---------------------------------------------------------------------------
// In-memory sources (detector fixtures)
// ---------------------------------------------------------------------------

const FIXTURE_OPTIONS: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], jsx: ts.JsxEmit.Preserve, strict: true, noEmit: true, skipLibCheck: true };
let fixtureHost: ts.CompilerHost | undefined;

export function scanSource(source: string, fileName: string): Finding[] {
  fixtureHost ??= ts.createCompilerHost(FIXTURE_OPTIONS);
  const base = fixtureHost;
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const host: ts.CompilerHost = {
    ...base,
    getSourceFile: (name, version, ...rest) => (name === fileName ? file : base.getSourceFile(name, version, ...rest)),
    fileExists: (name) => name === fileName || base.fileExists(name),
    readFile: (name) => (name === fileName ? source : base.readFile(name)),
  };
  const program = ts.createProgram({ rootNames: [fileName], options: FIXTURE_OPTIONS, host });
  return scanProgramFile(file, program.getTypeChecker(), fileName);
}

// ---------------------------------------------------------------------------
// Fingerprints and the exact-baseline ratchet
// ---------------------------------------------------------------------------

export const hashSnippet = (category: Category, snippet: string) =>
  createHash("sha256").update(`${category}\0${snippet}`).digest("hex").slice(0, 12);

/** One fingerprint per finding: (file, category, snippet hash, ordinal of that snippet in the file). */
export function fingerprints(findings: Finding[]): { list: string[]; snippets: Record<string, string> } {
  const ordinal = new Map<string, number>();
  const snippets: Record<string, string> = {};
  const sorted = [...findings].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.category.localeCompare(b.category) || a.snippet.localeCompare(b.snippet));
  const list = sorted.map((f) => {
    const hash = hashSnippet(f.category, f.snippet);
    snippets[hash] = f.snippet;
    const key = `${f.file}|${f.category}|${hash}`;
    const n = (ordinal.get(key) ?? 0) + 1;
    ordinal.set(key, n);
    return `${key}|${n}`;
  });
  return { list: list.sort(), snippets };
}

export interface Baseline {
  version: 1;
  /** Count per category (for review; the list is what is enforced). */
  counts: Record<string, number>;
  fingerprints: string[];
  /** hash → snippet, for reading the baseline. */
  snippets: Record<string, string>;
}

export interface ExceptionBatch {
  task: string;
  reason: string;
  fingerprints: string[];
}
export interface Exceptions {
  version: 1;
  batches: ExceptionBatch[];
}

export type Mode = "check" | "prune" | "accept";

export interface RatchetResult {
  ok: boolean;
  added: string[];
  stale: string[];
  /** Fingerprints `accept` would take without an exception record. */
  unexplained: string[];
  messages: string[];
  baseline?: Baseline;
  exceptions?: Exceptions;
}

export const countsOf = (list: string[]) => {
  const counts: Record<string, number> = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const fp of list) {
    const category = fp.split("|")[1] ?? "";
    counts[category] = (counts[category] ?? 0) + 1;
  }
  return counts;
};

/**
 * The rule: measured fingerprints == baseline fingerprints.
 * - check:  any new or stale fingerprint fails.
 * - prune:  drops stale fingerprints (and their exception records); refuses new ones.
 * - accept: takes new fingerprints only when each has an exception record
 *           (reason + task); also drops stale ones (file moves = stale + new).
 */
export function ratchet({
  measured,
  snippets,
  baseline,
  exceptions,
  mode,
}: {
  measured: string[];
  snippets: Record<string, string>;
  baseline: Baseline;
  exceptions: Exceptions;
  mode: Mode;
}): RatchetResult {
  const have = new Set(baseline.fingerprints);
  const now = new Set(measured);
  const added = measured.filter((fp) => !have.has(fp));
  const stale = baseline.fingerprints.filter((fp) => !now.has(fp));
  const explained = new Set(exceptions.batches.flatMap((b) => b.fingerprints));
  const unexplained = added.filter((fp) => !explained.has(fp));
  const messages: string[] = [];
  const show = (fp: string) => `${fp}  ${snippets[fp.split("|")[2] ?? ""] ?? baseline.snippets[fp.split("|")[2] ?? ""] ?? ""}`;
  const build = (list: string[]): Baseline => ({
    version: 1,
    counts: countsOf(list),
    fingerprints: [...list].sort(),
    snippets: Object.fromEntries(Object.entries({ ...baseline.snippets, ...snippets }).filter(([hash]) => list.some((fp) => fp.split("|")[2] === hash)).sort(([a], [b]) => a.localeCompare(b))),
  });
  const prunedExceptions = (keep: Set<string>): Exceptions => ({
    version: 1,
    batches: exceptions.batches.map((b) => ({ ...b, fingerprints: b.fingerprints.filter((fp) => keep.has(fp)) })).filter((b) => b.fingerprints.length > 0),
  });

  if (mode === "check") {
    if (added.length) messages.push(`${added.length} new design-token bypass(es) - use a token instead, or record an exception (reason + task) and run UPDATE_TOKEN_BASELINE=accept:\n${added.map(show).join("\n")}`);
    if (stale.length) messages.push(`${stale.length} fixed bypass(es) still in the baseline - run UPDATE_TOKEN_BASELINE=prune:\n${stale.map(show).join("\n")}`);
    return { ok: added.length === 0 && stale.length === 0, added, stale, unexplained, messages };
  }
  if (mode === "prune") {
    if (added.length) {
      messages.push(`prune refuses: ${added.length} new fingerprint(s) are not in the baseline:\n${added.map(show).join("\n")}`);
      return { ok: false, added, stale, unexplained, messages };
    }
    const list = baseline.fingerprints.filter((fp) => now.has(fp));
    return { ok: true, added, stale, unexplained, messages, baseline: build(list), exceptions: prunedExceptions(new Set(list)) };
  }
  if (unexplained.length) {
    messages.push(`accept refuses: ${unexplained.length} new fingerprint(s) have no exception record (reason + task) in designTokens.exceptions.json:\n${unexplained.map(show).join("\n")}`);
    return { ok: false, added, stale, unexplained, messages };
  }
  return { ok: true, added, stale, unexplained, messages, baseline: build(measured), exceptions: prunedExceptions(now) };
}

// ---------------------------------------------------------------------------
// The app sources
// ---------------------------------------------------------------------------

function walk(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, keep);
    return keep(path) ? [path] : [];
  });
}

/** Scan every app source under src/ (tests and EXEMPT_FILES excluded). */
export function scanApp(): { files: number; findings: Finding[] } {
  const config = ts.getParsedCommandLineOfConfigFile(join(ROOT, "tsconfig.app.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  });
  if (!config) throw new Error("tsconfig.app.json not readable");
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const checker = program.getTypeChecker();
  const files = walk(SRC, (path) => /\.(ts|tsx|css)$/.test(path))
    .map((path) => ({ path, rel: relative(ROOT, path).split(sep).join("/") }))
    .filter(({ rel }) => !isTestFile(rel) && !EXEMPT_FILES.includes(rel));
  const findings = files.flatMap(({ path, rel }) => {
    if (path.endsWith(".css")) return scanStylesheet(readFileSync(path, "utf8"), rel);
    const file = program.getSourceFile(path);
    if (!file) throw new Error(`${rel} is not in the tsconfig.app.json program`);
    return scanProgramFile(file, checker, rel);
  });
  return { files: files.length, findings };
}
