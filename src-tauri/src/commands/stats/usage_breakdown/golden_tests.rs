//! Cross-language reconciliation fixture (ADR 0002 §8, plan task `AN0b`).
//!
//! Runs the real command on small fixtures and pins the responses in
//! `src/test/fixtures/usageBreakdown.reconciliation.json`, which the
//! TypeScript tests price with the existing `calculateGlobalCostSummary`
//! and compare with `localDayIntervals`. A change in the command's output
//! fails here first; regenerate deliberately with
//! `CCHV_UPDATE_GOLDEN=1 cargo test golden -- --test-threads=1`.

use super::fixture::*;
use super::*;
use crate::commands::stats::get_project_stats_summary;
use crate::test_utils::SandboxHome;
use serde_json::{json, Value};
use serial_test::serial;
use std::path::PathBuf;

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/test/fixtures/usageBreakdown.reconciliation.json")
}

/// Replace the temporary root in every string so the file is stable.
fn normalize(value: Value, root: &str) -> Value {
    match value {
        Value::String(s) => Value::String(s.replace(root, "<root>")),
        Value::Array(items) => {
            Value::Array(items.into_iter().map(|v| normalize(v, root)).collect())
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, normalize(v, root)))
                .collect(),
        ),
        other => other,
    }
}

async fn scenario(name: &str, rows: Vec<FixtureRow>, intervals: Vec<UsageInterval>) -> Value {
    let fixture = UsageFixture::write(name, rows);
    let request = UsageBreakdownRequest {
        scope: UsageScope::Project {
            project_path: fixture.project_path(),
            provider: "claude".to_string(),
        },
        stats_mode: UsageStatsMode::BillingTotal,
        intervals,
    };
    let response = get_usage_breakdown(request.clone())
        .await
        .unwrap_or_else(|e| panic!("{name}: {e}"));
    let legacy = get_project_stats_summary(fixture.project_path(), None, None, None)
        .await
        .unwrap_or_else(|e| panic!("{name}: legacy {e}"));
    let root = fixture.root().to_string_lossy().to_string();
    normalize(
        json!({
            "request": request,
            "response": response,
            "legacy_model_distribution": legacy.model_distribution,
        }),
        &root,
    )
}

fn utc_days() -> Vec<UsageInterval> {
    vec![
        interval("2026-10-15", "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z"),
        interval("2026-10-16", "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z"),
        interval("2026-10-17", "2026-10-17T00:00:00Z", "2026-10-18T00:00:00Z"),
    ]
}

fn same_policy_rows() -> Vec<FixtureRow> {
    vec![
        row("s1", "a1", "2026-10-15T09:00:00Z")
            .tokens(1_000, 200, 50, 300)
            .cost(0.25),
        row("s1", "a2", "2026-10-15T09:05:00Z")
            .tokens(2_000, 100, 0, 600)
            .cost(0.5),
        row("s1", "a3", "2026-10-15T10:00:00Z")
            .model(HAIKU)
            .tokens(4_000, 400, 0, 0),
        row("s2", "b1", "2026-10-16T14:00:00Z")
            .model(HAIKU)
            .tier("fast")
            .tokens(500, 50, 0, 100),
        row("s3", "c1", "2026-10-17T08:00:00Z")
            .model(HAIKU)
            .tokens(300, 30, 0, 0),
    ]
}

fn mixed(second_ts: &str) -> Vec<FixtureRow> {
    vec![
        row("s1", "first", "2026-10-15T12:00:00Z")
            .tokens(1_000_000, 0, 0, 0)
            .cost(1.0),
        row("s1", "second", second_ts).tokens(1_000_000, 0, 0, 0),
    ]
}

async fn build_golden() -> Value {
    let undated = vec![
        row("s1", "dated", "2026-10-15T12:00:00Z").tokens(100, 0, 0, 0),
        row("s1", "undated", "").undated().tokens(7, 0, 0, 0),
    ];
    let mut scenarios = serde_json::Map::new();
    let mut add = |name: &str, value: Value| {
        scenarios.insert(name.to_string(), value);
    };
    add(
        "same_policy_days",
        scenario("same-policy", same_policy_rows(), utc_days()).await,
    );
    add(
        "same_policy_range",
        scenario(
            "same-policy",
            same_policy_rows(),
            vec![interval(
                "all",
                "2026-10-15T00:00:00Z",
                "2026-10-18T00:00:00Z",
            )],
        )
        .await,
    );
    add(
        "mixed_by_day",
        scenario("mixed-day", mixed("2026-10-16T12:00:00Z"), utc_days()).await,
    );
    add(
        "mixed_by_turn",
        scenario("mixed-turn", mixed("2026-10-15T12:10:00Z"), utc_days()).await,
    );
    // Asia/Kolkata (UTC+5:30): 18:20Z is 23:50 on the 17th, 18:40Z is
    // 00:10 on the 18th — one UTC hour, two local days.
    add(
        "kolkata",
        scenario(
            "kolkata",
            vec![
                row("s1", "k1", "2026-10-17T18:20:00Z").tokens(10, 0, 0, 0),
                row("s1", "k2", "2026-10-17T18:40:00Z").tokens(20, 0, 0, 0),
            ],
            vec![
                interval("2026-10-17", "2026-10-16T18:30:00Z", "2026-10-17T18:30:00Z"),
                interval("2026-10-18", "2026-10-17T18:30:00Z", "2026-10-18T18:30:00Z"),
            ],
        )
        .await,
    );
    // Pacific/Apia skipped 2011-12-30: UTC-10 until 2011-12-30T10:00Z, then
    // UTC+14, so the 30th is a zero-length interval.
    add(
        "apia",
        scenario(
            "apia",
            vec![
                row("s1", "p1", "2011-12-29T12:00:00Z").tokens(10, 0, 0, 0),
                row("s1", "p2", "2011-12-30T12:00:00Z").tokens(20, 0, 0, 0),
            ],
            vec![
                interval("2011-12-29", "2011-12-29T10:00:00Z", "2011-12-30T10:00:00Z"),
                interval("2011-12-30", "2011-12-30T10:00:00Z", "2011-12-30T10:00:00Z"),
                interval("2011-12-31", "2011-12-30T10:00:00Z", "2011-12-31T10:00:00Z"),
            ],
        )
        .await,
    );
    add(
        "undated",
        scenario("undated", undated.clone(), utc_days()).await,
    );
    add(
        "undated_removed",
        scenario("undated", undated[..1].to_vec(), utc_days()).await,
    );
    json!({
        "_comment": "Generated by src-tauri/src/commands/stats/usage_breakdown/golden_tests.rs from the real get_usage_breakdown command. Do not edit by hand; regenerate with CCHV_UPDATE_GOLDEN=1.",
        "scenarios": Value::Object(scenarios),
    })
}

#[tokio::test]
#[serial]
async fn golden_reconciliation_fixture_matches_the_command() {
    let _home = SandboxHome::new();
    let built = build_golden().await;
    let path = golden_path();
    if std::env::var_os("CCHV_UPDATE_GOLDEN").is_some_and(|v| v == "1") {
        let mut text = serde_json::to_string_pretty(&built).unwrap();
        text.push('\n');
        std::fs::write(&path, text).expect("write golden");
    }
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e} (regenerate with CCHV_UPDATE_GOLDEN=1)",
            path.display()
        )
    }))
    .expect("golden is JSON");
    assert_eq!(
        stored, built,
        "regenerate with CCHV_UPDATE_GOLDEN=1 if the change is intended"
    );
}
