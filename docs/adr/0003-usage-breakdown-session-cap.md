# 0003 — Usage breakdown: `sessions` capped at the top 250 by cost plus one remainder row

- **Status**: accepted
- **Date**: 2026-10-19
- **Supersedes**: [ADR 0002](0002-usage-breakdown.md) §10, the response-size line (≤ 1 MiB now
  holds on the reference fixture and is asserted). Narrows ADR 0002 §5 "No new price function
  exists" to displayed costs (§3 below). Amends ADR 0002 §9 (coverage): symlinks, unreadable
  parts of a root and the `not_found` status (§7 below). Everything else in ADR 0002 stands.
- **Plan reference**: inner-UI plan v3 §4.7 (budget: "세션 목록을 상위 n + 나머지 합으로"), §4.9
  (session detail), §5 rows AN1 and AN2.

## Context

AN0b measured the ADR 0002 §10 budgets on the reference fixture (25 projects, 90 KST days,
50,000 Claude rows, 1,000 sessions; Apple M4 Pro, release build). Time and memory were within
budget (cold 74 ms, warm 36.9 ms, contribution cache 2.69 MiB). The response was not: 1,941 KiB
against 1 MiB. `intervals` took 339 KiB; `sessions` took 1,602 KiB, about 1.6 KiB per session (a
source and an estimate bucket each, each with its `context_breakdown`). Session rows are the part
that grows with use: 250 sessions fit (724 KiB), 1,000 did not. ADR 0002 §10 offered three ways
out; the owner chose (a): list the top n sessions plus one remainder row, and change nothing else
in the contract.

Two facts shape the details:

- The overview's session table is "sessions by estimated cost" (plan §4.7; AN1: top 5 plus
  "n others"). A cut by tokens drops exactly the sessions that table is for: a session of cache
  reads on Haiku has many tokens and costs little, a short Opus session has few tokens and costs
  a lot. The cut has to rank by cost.
- Pricing lived only in the frontend (ADR 0002, Context); Rust had no price table.

## Decision

### 1. Response shape: one new field

```
UsageBreakdownResponse {
  intervals:         [...],                                  // unchanged
  sessions:          [SessionUsage],                         // at most MAX_SESSIONS, ranked (§2)
  session_remainder: { models: [PricedModelStats], message_count, session_count },
  coverage:          {...},                                  // unchanged
}
```

- `MAX_SESSIONS = 250` (Rust) and `MAX_USAGE_SESSIONS` (TypeScript). The shared contract fixture
  (`usageBreakdown.contract.json`, `limits`) pins both, and now pins `MAX_INTERVALS` the same way.
- The remainder merges every session that is not listed, bucket by bucket, under the same key as
  an interval: (provider, model, service tier, pricing source). Source and estimate buckets stay
  apart, each bucket keeps its `context_breakdown`, and a source bucket keeps its summed
  `cost_usd`.
- **Nothing cut: the remainder is present with zero values**, `{ "models": [], "message_count": 0,
  "session_count": 0 }`, never absent and never null. This is the interval rule of ADR 0002 §1
  (a row with zeros when nothing happened): `sessions` + `session_remainder` = `intervals` needs
  no branch, and `session_count > 0` means something was cut (every session in a response has at
  least one counted row).
- The cap applies to every response, whatever the scope and intervals. The request is unchanged,
  and the Tauri command and the Axum route still run the same function.

### 2. Order of `sessions`

1. Cost, descending: the provider-reported cost of source buckets plus the price-table estimate
   of estimate buckets, as `summarizeBucketCost(models).totalEstimatedCost` computes it (§3).
   An unpriced bucket counts 0.
2. Total tokens, descending.
3. `last_ts`, descending (latest activity first).
4. `ref`, ascending, field by field: provider, file_path, session_id, project_path.

The first `MAX_SESSIONS` are listed in this order, so equal inputs always give the same list.

### 3. The ranking cost mirrors the frontend's price function

To rank by cost the backend has to price. `usage_breakdown/ranking.rs` mirrors
`calculateGlobalCostSummary`, `calculateContextBreakdownPrice` and `findModelPricing`
(`globalCalculations.ts`, `calculations.ts`) over the same table, `src/data/model-pricing.json`,
embedded at compile time the way `menu/manifest.rs` embeds `src/commands/manifest.json`: longest
matching key, service tier (`priority` = `fast`), the context tier of each `context_breakdown`
entry, 5-minute and 1-hour cache-write rates, reasoning at the output rate, the
unsupported-model patterns and the source-cost-only providers. Same operations in the same
order, so both sides produce the same number.

- The value **only orders sessions**. It is not on the wire, and every cost the user sees is
  still computed by the frontend. ADR 0002 §5 therefore reads: no new price function for any
  displayed number; one ordering-only mirror in Rust.
- Drift guards:
  - the table is the same file, so a price edit reaches both sides;
  - the two rule lists that live in TypeScript code are read from `calculations.ts` by a Rust test
    (`rule_lists_match_the_frontend_pricing_module`);
  - the golden file records the backend's ranking cost of every listed session of every scenario,
    and `usageBreakdown.reconciliation.test.ts` asserts it equals `summarizeBucketCost` to 12
    digits (all 18 golden sessions are bit-identical today). Its `session_cap` scenario covers a
    fast tier, 1-hour cache writes, a long-context tier, provider cost, a mixed session and an
    unpriced model.
  - Not caught: a change to the TypeScript pricing *rules* that no scenario exercises. It can
    only move sessions near the cut; it never changes a displayed number or a total.
- Rejected:
  - ranking by tokens: it cuts expensive light sessions, the case the overview table exists for;
  - prices in the request: a new request field the plan does not need.

### 4. Invariants (tests first)

- `sessions` + `session_remainder` = `intervals`, per bucket key: tokens and message counts
  exactly, provider cost within 1e-9. Priced by `summarizeBucketCost`, the exact, estimated and
  unpriced parts agree to the cent. Asserted over the cap
  (`cap_listed_sessions_plus_remainder_equal_interval_sums_to_the_cent`, golden `session_cap`)
  and under it (`an0b_interval_sum_equals_range_and_session_sums`, every other golden scenario).
- Listed sessions + `session_remainder.session_count` = the sessions with a counted row.
- Merging cut sessions into one row does not change their cost: the estimate is linear per
  (model, tier, context tier) (ADR 0002 §5).

### 5. Consumers that need a session that may be cut

- **AN1 overview** ("sessions by estimated cost", top 5 + "n others"; "the largest contributing
  session"): the top 5 are always listed, in the frontend's cost order. "n others" is
  `sessions.length − 5 + session_remainder.session_count`, and pricing the listed rest plus the
  remainder's buckets gives their exact cost.
- **Session detail sheet** (§4.9; reached from the overview table, the activity day list, the
  desktop inspector and the phone conversation menu): the sheet asks a narrower question
  instead of a new field. "In this project" requests `scope: { kind: "project", project_path,
  provider }` over the analytics period; share of project tokens, project session count and
  average per message stay exact (they come from `intervals` and the remainder). The session's
  own usage requests intervals around its own span. A session is cut from a project-scope
  response only when the project has more than 250 sessions with rows in the period and the
  session ranks below them. Ranks and percentiles ("3rd of 42 by tokens", duration rank) are
  exact only when `session_remainder.session_count == 0`; otherwise AN2 says they are among the
  listed sessions, or narrows the period. The plan does not require a new request field, so none
  is added.
- **Activity tab day list** (AN2): request that day's interval; the day's sessions are listed up
  to 250.

### 6. Budget (replaces the response-size line of ADR 0002 §10)

Reference fixture as in ADR 0002 §10 (25 projects, 90 KST days, 50,000 Claude rows), release
build, Apple M4 Pro, `cargo test --release perf_budget -- --ignored --nocapture
--test-threads=1` (`CCHV_PERF_ROWS_PER_SESSION=200` for 250 sessions).

| Measure | 1,000 sessions | 250 sessions | Budget |
|---|---|---|---|
| Response size | **718.6 KiB** (was 1,986.2 KiB uncut) | 735.0 KiB (nothing cut) | ≤ 1 MiB, asserted |
| · intervals | 339.4 KiB, 540 buckets | 315.0 KiB, 500 buckets | |
| · sessions | 375.0 KiB, 250 listed, 498 buckets | 419.8 KiB, 250 listed, 500 buckets | |
| · session_remainder | 3.9 KiB, 750 sessions, 6 buckets | 0.0 KiB, zero row | |
| Cold request | 80 ms | 48 ms | ≤ 3 s |
| Warm request (median of 5) | 18.7 ms | 7.6 ms | ≤ 300 ms |
| Contribution cache | 2.69 MiB | 2.39 MiB | ≤ 64 MiB |

- The uncut figure was re-measured under the same conditions as the capped one (1,986.2 KiB;
  AN0b's 1,941 KiB came from a shorter temporary path in every `ref`).
- The response size is deterministic and asserted in every build; time and memory are asserted
  in release builds, as before.
- 250 is the owner's starting point, confirmed by measurement: about 30 % below the budget on
  the reference fixture, and AN1 needs 5.

### 7. What a scan does not read (amends ADR 0002 §9)

Coverage says what was read; these rules decide what is read at all. They come from the AN0b
review, which reproduced each case through the read-only HTTP route.

**Symlinks are never followed inside a history root.** The Claude walk
(`commands/stats/session_files.rs`) is shared by the old stats commands and this command, so
both read the same file set: every `*.jsonl` entry under a project directory that is not a
symlink. A symlinked project directory under `projects/` is not walked either.

- The root a request names may itself be reached through a symlink (a symlinked `~/.claude`,
  #355). The HTTP route's root guard judges it by its canonical path; nothing inside it is
  followed.
- A skipped link that resolves inside one of the request's canonical roots is an **alias** of
  history that is read directly, so it is dropped silently (it used to be counted twice). Any
  other skipped link — out of the roots, or dangling — is **refused** and counts as a source
  that was not read: the provider is `partial` (or `unreadable` when nothing else was read),
  never `scanned`.
- Defense in depth: a file is opened only as a regular file whose canonical path lies inside the
  root it was found under, through its canonical path, and the opened handle must be the file
  that was checked (same device and inode on Unix). A file swapped for a symlink after the walk
  is not read. The contribution cache never answers a symlink with its target's entry.

**What a walk cannot read is reported.** An entry the Claude walk cannot read — a subdirectory
or project directory it may not list, an I/O error while listing `projects/` — counts as a
source that was not read: `partial` when something else was read, `unreadable` when nothing
was. Such errors used to be dropped, so a project whose only history sat in a mode-000
directory was `scanned` with zero usage.

**A store that is not there is `not_found`.** Coverage gains a fifth status: `not_found` — the
provider has no history store on this machine, or the requested project directory does not
exist. Nothing was read and nothing failed, which is neither `scanned` (a store that was read and
held no usage) nor `unreadable` (a store that exists but cannot be read).

- The existing provider scanners answer `Ok([])` for an empty store and for no store alike
  (Gemini, Pi, Qwen, …) and an error for some missing stores (Codex), so availability is decided
  before a scanner runs (`usage_breakdown/availability.rs`). Presence is the provider's own
  detection — `detect()`, the one the provider list uses — so no store layout is copied; the
  store root it names must also open, or the provider is `unreadable`.
- Claude: none of the request's `projects/` folders exists → `not_found`; a root without one adds
  nothing. A custom root that fails validation is still a failed source.
- Wire: `ProviderScanStatus` in Rust and TypeScript, and the contract fixture's
  `provider_scan_statuses` lists all five values for both contract tests.

## Consequences

- The response is bounded by `intervals` plus 250 session rows: 718.6 KiB instead of 1,986.2 KiB
  for 1,000 sessions. Ranking and merging cost no measurable time (warm 18.7 ms capped against
  19.2 ms uncut in the same session, within run-to-run noise).
- AN1 and AN2 treat `sessions` as the top 250 and `session_remainder` as the rest. A list that
  needs every session asks a narrower question: project scope, one day, or the session's span.
- The backend carries an ordering-only copy of the price rules. A rule change in
  `calculations.ts` has to be mirrored in `ranking.rs`; the guards in §3 catch the cases they
  cover. A price edit reaches both sides through the shared table; when it touches a model the
  golden scenarios use (Sonnet 4.5, Haiku 5.5, Opus 5.5) the recorded ranking costs change, and
  the Rust golden test asks for `CCHV_UPDATE_GOLDEN=1`. The `ranking.rs` unit tests read their
  expected rates from the table, so they survive price edits (one canonical check keeps Sonnet
  4.5 input at $3 / 1M, the example of ADR 0002 §8 (3) that the TypeScript tests already use).
- The cap bounds the number of session rows, not their bytes. A row grows with its buckets: with
  every session mixing 2 models the reference response is 965.6 KiB (6 % below the budget), with
  3 models 1,236.8 KiB (over), measured with `CCHV_PERF_MODELS_PER_SESSION`. If real histories
  look like that, lowering `MAX_SESSIONS` (≈ 200 keeps 2-model sessions near 840 KiB, by
  proportion) is a one-constant change pinned by the contract fixture.
- The golden file is compared as text: the recorded ranking costs are computed floats, and
  serde_json's default parser does not promise an exact round trip.
