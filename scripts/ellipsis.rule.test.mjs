// Copy-format rules of the i18n validator (plan F4a, audit G-MC3 / G-MC4):
// `{{count}}` needs a plural bundle, no `(s)`, no ASCII `...` in prose.
// Code and command literals are exempt: backtick spans inside a value, and
// keys on the code-literal list (a value that is a command example).
import { describe, expect, it } from "vitest";
import { checkAllowlist, findCopyViolations, proseOf } from "./i18n-rules.mjs";

const rulesOf = (entries, options) => findCopyViolations(entries, options).map((v) => `${v.rule}:${v.key}`);

describe("proseOf", () => {
  it("drops backtick code spans", () => {
    expect(proseOf("Run `npm run dev...` first")).toBe("Run  first");
    expect(proseOf("no code")).toBe("no code");
  });
});

describe("ascii ellipsis", () => {
  it("fails prose with ...", () => {
    expect(rulesOf({ "common.loading": "Loading..." })).toEqual(["ascii-ellipsis:common.loading"]);
  });

  it("passes the typographic ellipsis", () => {
    expect(rulesOf({ "common.loading": "Loading…" })).toEqual([]);
  });

  it("passes a code literal inside backticks", () => {
    expect(rulesOf({ "x.hint": "Run `npm run dev...`" })).toEqual([]);
  });

  it("passes a key on the code-literal list", () => {
    expect(rulesOf({ "x.example": "npx -y server ..." }, { codeLiteralKeys: ["x.example"] })).toEqual([]);
  });

  it("still fails prose outside the backticks", () => {
    expect(rulesOf({ "x.hint": "Run `npm run dev` and wait..." })).toEqual(["ascii-ellipsis:x.hint"]);
  });
});

describe("parenthetical plural", () => {
  it("fails (s)", () => {
    expect(rulesOf({ "x.files": "{{n}} file(s) changed" })).toEqual(["parenthetical-plural:x.files"]);
  });

  it("ignores (s) inside code", () => {
    expect(rulesOf({ "x.regex": "Matches `file(s)`" })).toEqual([]);
  });
});

describe("count without plural", () => {
  it("fails {{count}} in a key that is not a plural form", () => {
    expect(rulesOf({ "x.sessions": "{{count}} sessions" })).toEqual(["count-without-plural:x.sessions"]);
    expect(rulesOf({ "x.sessions": "{{ count, number }} sessions" })).toEqual(["count-without-plural:x.sessions"]);
  });

  it("passes a plural bundle", () => {
    expect(rulesOf({ "x.sessions_one": "{{count}} session", "x.sessions_other": "{{count}} sessions" })).toEqual([]);
  });

  it("does not confuse other variables with count", () => {
    expect(rulesOf({ "x.total": "{{counted}} of {{total}}" })).toEqual([]);
  });

  it("can be limited to the base locale", () => {
    expect(rulesOf({ "x.sessions": "{{count}} 세션" }, { rules: ["ascii-ellipsis", "parenthetical-plural"] })).toEqual([]);
  });
});

describe("checkAllowlist (ratchet)", () => {
  const violations = [
    { rule: "ascii-ellipsis", lang: "en", key: "a" },
    { rule: "ascii-ellipsis", lang: "ko", key: "a" },
  ];

  it("accepts violations that are on the starting allowlist", () => {
    const out = checkAllowlist(violations, { "ascii-ellipsis": { en: ["a"], ko: ["a"] } });
    expect(out.unlisted).toEqual([]);
    expect(out.stale).toEqual([]);
  });

  it("fails a new violation", () => {
    const out = checkAllowlist(violations, { "ascii-ellipsis": { en: ["a"] } });
    expect(out.unlisted).toEqual([{ rule: "ascii-ellipsis", lang: "ko", key: "a" }]);
  });

  it("fails an allowlist entry that no longer violates, so the list only shrinks", () => {
    const out = checkAllowlist([], { "ascii-ellipsis": { en: ["a"] } });
    expect(out.stale).toEqual([{ rule: "ascii-ellipsis", lang: "en", key: "a" }]);
  });
});
