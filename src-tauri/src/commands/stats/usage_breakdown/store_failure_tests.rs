//! A store that is there but cannot be read in part is never a `scanned`
//! zero (ADR 0003 §7, `AN0b` re-review P2).
//!
//! For every token-reporting provider, each directory or file of a present
//! store that its scan reads is locked (mode 000) in turn while it holds
//! the store's only session. The provider must then be `unreadable`: the
//! scan may keep going past what it cannot read, but it has to say so.

use super::fixture::*;
use super::*;
use crate::test_utils::SandboxHome;
use serde_json::{json, Value};
use serial_test::serial;
use std::fs;
use std::path::{Path, PathBuf};

/// One provider's store in a sandbox home, holding one session.
struct Store {
    provider: &'static str,
    /// Points the provider at the sandbox where its default path would not.
    env: Vec<EnvGuard>,
    /// Parts of the store its scan reads; each one alone at mode 000 leaves
    /// the session unreadable.
    locks: Vec<PathBuf>,
}

impl Store {
    fn new(provider: &'static str, locks: Vec<PathBuf>) -> Self {
        Self {
            provider,
            env: Vec::new(),
            locks,
        }
    }

    fn with_env(mut self, key: &'static str, value: &Path) -> Self {
        self.env.push(EnvGuard::set(key, value));
        self
    }
}

type Fixture = fn(&Path) -> Store;

const READABLE: &str = "scanned, 1 session read";
const UNREADABLE: &str = "unreadable, 0 sessions read";

/// The provider's coverage in an `all` request for it alone. Each request
/// starts with a cold contribution cache: it keys on size and mtime, which a
/// chmod leaves alone, so it would answer for a locked file it read before.
async fn coverage_of(provider: &str, home: &Path) -> String {
    super::contribution_cache::contribution_cache().clear();
    let request = UsageBreakdownRequest {
        scope: UsageScope::All {
            providers: vec![provider.to_string()],
            claude_path: home.join(".claude").to_string_lossy().to_string(),
            custom_claude_paths: Vec::new(),
        },
        stats_mode: UsageStatsMode::BillingTotal,
        intervals: vec![interval(
            "2020s",
            "2020-01-01T00:00:00Z",
            "2030-01-01T00:00:00Z",
        )],
    };
    let response = get_usage_breakdown(request).await.expect("breakdown");
    let coverage = &response.coverage.providers[0];
    let status = serde_json::to_value(coverage.status).unwrap();
    let read = coverage.sessions_scanned;
    let noun = if read == 1 { "session" } else { "sessions" };
    format!("{}, {read} {noun} read", status.as_str().unwrap())
}

/// Every fixture readable, then each of its locks in turn: one assertion
/// over every provider, so a failure shows the whole matrix.
async fn check(fixtures: &[Fixture]) {
    let mut seen = Vec::new();
    let mut expected = Vec::new();
    for fixture in fixtures {
        let home = SandboxHome::new();
        let _cleared = without_store_env();
        // `_env` holds the store's own env overrides until the next store.
        let Store {
            provider,
            env: _env,
            locks,
        } = fixture(home.path());
        seen.push((
            provider,
            "-".to_string(),
            coverage_of(provider, home.path()).await,
        ));
        expected.push((provider, "-".to_string(), READABLE.to_string()));
        for lock in &locks {
            let part = lock
                .strip_prefix(home.path())
                .unwrap()
                .display()
                .to_string();
            // As root, mode 000 locks nothing: this store's lock rows are
            // skipped, and its readable row and the other stores still count.
            let Some(_locked) = Unreadable::new(lock) else {
                break;
            };
            seen.push((
                provider,
                part.clone(),
                coverage_of(provider, home.path()).await,
            ));
            expected.push((provider, part, UNREADABLE.to_string()));
        }
    }
    assert_eq!(seen, expected);
}

#[tokio::test]
#[serial]
async fn an_unreadable_part_of_a_file_store_is_never_a_scanned_zero() {
    check(&[
        claude,
        codex,
        openinterpreter,
        gemini,
        qwen,
        pi,
        ompi,
        grok,
        kimi,
        kimi_code,
        cline,
        copilot_cli,
        copilot_vscode,
        antigravity,
    ])
    .await;
}

#[tokio::test]
#[serial]
async fn an_unreadable_part_of_a_database_store_is_never_a_scanned_zero() {
    check(&[opencode, kilo, forgecode, zcode, llm, cursor]).await;
}

// ---- fixtures ----------------------------------------------------------------

fn write_lines(path: &Path, lines: &[Value]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut body = String::new();
    for line in lines {
        body.push_str(&line.to_string());
        body.push('\n');
    }
    fs::write(path, body).unwrap();
}

/// A Codex-format rollout (Codex and Open Interpreter) with token usage.
fn write_rollout(day_dir: &Path, id: &str) -> PathBuf {
    let path = day_dir.join(format!("rollout-2026-10-16T09-00-00-{id}.jsonl"));
    write_lines(
        &path,
        &[
            json!({"timestamp": "2026-10-16T09:00:00Z", "type": "session_meta",
                   "payload": {"id": id, "cwd": "/work/app"}}),
            json!({"timestamp": "2026-10-16T09:00:01Z", "type": "turn_context",
                   "payload": {"model": "gpt-5-codex", "cwd": "/work/app"}}),
            json!({"timestamp": "2026-10-16T09:00:02Z", "type": "response_item",
                   "payload": {"type": "message", "role": "user",
                               "content": [{"type": "input_text", "text": "hi"}]}}),
            json!({"timestamp": "2026-10-16T09:00:03Z", "type": "response_item",
                   "payload": {"type": "message", "role": "assistant",
                               "content": [{"type": "output_text", "text": "done"}]}}),
            json!({"timestamp": "2026-10-16T09:00:04Z", "type": "event_msg",
                   "payload": {"type": "token_count", "info": {"total_token_usage":
                               {"input_tokens": 1200, "cached_input_tokens": 200,
                                "output_tokens": 80}}}}),
        ],
    );
    path
}

/// `~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl`.
fn codex(home: &Path) -> Store {
    let sessions = home.join(".codex/sessions");
    let rollout = write_rollout(&sessions.join("2026/10/16"), "codex-s1");
    Store::new(
        "codex",
        vec![sessions.clone(), sessions.join("2026/10/16"), rollout],
    )
}

/// `~/.openinterpreter/sessions/…`: the Codex rollout format.
fn openinterpreter(home: &Path) -> Store {
    let sessions = home.join(".openinterpreter/sessions");
    let rollout = write_rollout(&sessions.join("2026/10/16"), "oi-s1");
    Store::new(
        "openinterpreter",
        vec![sessions.clone(), sessions.join("2026/10/16"), rollout],
    )
}

/// `~/.gemini/tmp/<project hash>/chats/session-*.json`.
fn gemini(home: &Path) -> Store {
    let tmp = home.join(".gemini/tmp");
    let project = tmp.join("projhash");
    let session = project.join("chats/session-2026-10-16T01-00-abc.json");
    write_lines(
        &session,
        &[json!({
            "sessionId": "abc", "projectHash": "projhash", "kind": "main",
            "startTime": "2026-10-16T01:00:00Z", "lastUpdated": "2026-10-16T01:00:00Z",
            "messages": [
                {"id": "u1", "type": "user", "timestamp": "2026-10-16T01:00:00Z", "content": "hi"},
                {"id": "g1", "type": "gemini", "timestamp": "2026-10-16T01:00:01Z",
                 "model": "gemini-2.5-pro", "content": [{"text": "sure"}],
                 "tokens": {"input": 70, "output": 7, "cached": 0}}
            ]
        })],
    );
    Store::new(
        "gemini",
        vec![tmp, project.clone(), project.join("chats"), session],
    )
}

/// An OpenCode-core database (`opencode.db`, `kilo.db`) with one session.
fn write_opencode_core_db(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let conn = crate::providers::kilo::test_support::create_db(path);
    crate::providers::kilo::test_support::seed(&conn);
    crate::providers::kilo::test_support::seed_assistant_usage(&conn, 100, 50);
}

/// `~/.local/share/opencode/opencode.db`.
fn opencode(home: &Path) -> Store {
    let db = home.join(".local/share/opencode/opencode.db");
    write_opencode_core_db(&db);
    Store::new("opencode", vec![db])
}

/// `~/.local/share/kilo/kilo.db`.
fn kilo(home: &Path) -> Store {
    let db = home.join(".local/share/kilo/kilo.db");
    write_opencode_core_db(&db);
    Store::new("kilo", vec![db])
}

/// `~/.claude/projects/<project>/<session>.jsonl`.
fn claude(home: &Path) -> Store {
    let projects = home.join(".claude/projects");
    let project = projects.join("-work-app");
    let session = project.join("s1.jsonl");
    write_lines(
        &session,
        &[row("s1", "a1", "2026-10-16T09:00:00Z")
            .tokens(100, 10, 0, 0)
            .to_json()],
    );
    Store::new(
        "claude",
        vec![home.join(".claude"), projects, project, session],
    )
}

/// `~/.qwen/projects/<dir>/chats/<session>.jsonl`.
fn qwen(home: &Path) -> Store {
    let qwen = home.join(".qwen");
    let project = qwen.join("projects/-work-app");
    let session = project.join("chats/sess-q1.jsonl");
    write_lines(
        &session,
        &[
            json!({"uuid": "u1", "sessionId": "sess-q1", "timestamp": "2026-10-16T09:00:00Z",
                   "type": "user", "cwd": "/work/app",
                   "message": {"role": "user", "parts": [{"text": "hi"}]}}),
            json!({"uuid": "a1", "parentUuid": "u1", "sessionId": "sess-q1",
                   "timestamp": "2026-10-16T09:00:01Z", "type": "assistant",
                   "model": "qwen3-coder-plus",
                   "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 34},
                   "message": {"role": "model", "parts": [{"text": "ok"}]}}),
        ],
    );
    Store::new(
        "qwen",
        vec![
            qwen.clone(),
            qwen.join("projects"),
            project.clone(),
            project.join("chats"),
            session,
        ],
    )
}

/// `~/<dot dir>/agent/sessions/<project>/<session>.jsonl` (Pi, oh-my-pi).
fn pi_layout(home: &Path, dot_dir: &str, provider: &'static str) -> Store {
    let top = home.join(dot_dir);
    let sessions = top.join("agent/sessions");
    let project = sessions.join("--work-app--");
    let session = project.join("2026-10-16T09-00-00-000Z_s1.jsonl");
    write_lines(
        &session,
        &[
            json!({"type": "session", "version": 3, "id": "s1",
                   "timestamp": "2026-10-16T09:00:00.000Z", "cwd": "/work/app"}),
            json!({"type": "message", "id": "u1", "timestamp": "2026-10-16T09:00:01.000Z",
                   "message": {"role": "user", "content": "hi"}}),
            json!({"type": "message", "id": "a1", "parentId": "u1",
                   "timestamp": "2026-10-16T09:00:02.000Z",
                   "message": {"role": "assistant", "provider": "anthropic",
                               "model": "claude-opus-4-8",
                               "content": [{"type": "text", "text": "ok"}],
                               "usage": {"input": 12, "output": 34, "cacheRead": 0,
                                         "cacheWrite": 0, "totalTokens": 46}}}),
        ],
    );
    Store::new(
        provider,
        vec![top.clone(), top.join("agent"), sessions, project, session],
    )
}

fn pi(home: &Path) -> Store {
    pi_layout(home, ".pi", "pi")
}

fn ompi(home: &Path) -> Store {
    pi_layout(home, ".omp", "ompi")
}

/// `~/.grok/sessions/<encoded cwd>/<session>/{summary.json,chat_history.jsonl}`.
fn grok(home: &Path) -> Store {
    let top = home.join(".grok");
    let project = top.join("sessions/%2Fwork%2Fapp");
    let session = project.join("019fa555-791c-71e2-8c92-ff2e6fa26d6e");
    let summary = session.join("summary.json");
    let chat = session.join("chat_history.jsonl");
    write_lines(
        &summary,
        &[json!({
            "info": {"id": "019fa555-791c-71e2-8c92-ff2e6fa26d6e", "cwd": "/work/app"},
            "session_summary": "Demo", "created_at": "2026-10-16T09:00:00Z",
            "updated_at": "2026-10-16T09:01:00Z", "num_chat_messages": 2,
            "current_model_id": "grok-4.5"
        })],
    );
    write_lines(
        &chat,
        &[
            json!({"type": "user", "content": [{"type": "text", "text": "hi"}]}),
            json!({"type": "assistant", "content": "ok", "model_id": "grok-4.5"}),
        ],
    );
    Store::new(
        "grok",
        vec![
            top.clone(),
            top.join("sessions"),
            project,
            session,
            summary,
            chat,
        ],
    )
}

/// The old Kimi CLI: `~/.kimi/sessions/<project>/<session>/context.jsonl`.
fn kimi(home: &Path) -> Store {
    let top = home.join(".kimi");
    let project = top.join("sessions/proj-hash");
    let session = project.join("sess-k1");
    let context = session.join("context.jsonl");
    write_lines(
        &context,
        &[
            json!({"role": "user", "content": "hi"}),
            json!({"role": "assistant", "content": "ok"}),
        ],
    );
    write_lines(
        &session.join("wire.jsonl"),
        &[json!({"timestamp": 1_760_605_200.0})],
    );
    Store::new(
        "kimi",
        vec![top.clone(), top.join("sessions"), project, session, context],
    )
}

/// kimi-code, also the `kimi` provider:
/// `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl`.
fn kimi_code(home: &Path) -> Store {
    let top = home.join(".kimi-code");
    let workspace = top.join("sessions/wd_demo");
    let session = workspace.join("session_one");
    let wire = session.join("agents/main/wire.jsonl");
    write_lines(
        &wire,
        &[json!({"type": "context.append_message",
                 "message": {"role": "user", "content": [{"type": "text", "text": "hi"}],
                             "toolCalls": [], "origin": {"kind": "user"},
                             "id": "session_one_u1"},
                 "time": 1_786_959_458_516_u64})],
    );
    Store::new(
        "kimi",
        vec![
            top.clone(),
            top.join("sessions"),
            workspace,
            session.clone(),
            session.join("agents"),
            session.join("agents/main"),
            wire,
        ],
    )
}

/// Cline's VS Code extension directory: `state/taskHistory.json` lists the
/// tasks, `tasks/<id>/ui_messages.json` holds each one.
fn cline(home: &Path) -> Store {
    let global = crate::utils::config_dir()
        .unwrap()
        .join("Code/User/globalStorage");
    let ext = global.join("saoudrizwan.claude-dev");
    let history = ext.join("state/taskHistory.json");
    write_lines(
        &history,
        &[
            json!([{"id": "task-1", "ts": 1_760_605_200_000_u64, "task": "hi",
                  "tokensIn": 100, "tokensOut": 50,
                  "cwdOnTaskInitialization": "/work/app"}]),
        ],
    );
    let task = ext.join("tasks/task-1");
    let messages = task.join("ui_messages.json");
    write_lines(
        &messages,
        &[json!([{"type": "say", "say": "text", "text": "hello",
                  "ts": 1_760_605_200_000_u64}])],
    );
    assert!(global.starts_with(home));
    Store::new(
        "cline",
        vec![
            global,
            ext.clone(),
            ext.join("state"),
            history,
            ext.join("tasks"),
            task,
            messages,
        ],
    )
}

/// Copilot CLI: `~/.copilot/session-state/<id>/events.jsonl`.
fn copilot_cli(home: &Path) -> Store {
    let top = home.join(".copilot");
    let session = top.join("session-state/11111111-1111-1111-1111-111111111111");
    let events = session.join("events.jsonl");
    write_lines(
        &events,
        &[
            json!({"type": "session.start",
                   "data": {"sessionId": "11111111-1111-1111-1111-111111111111",
                            "context": {"cwd": "/work/app"}},
                   "timestamp": "2026-10-16T09:00:00.000Z"}),
            json!({"type": "user.message", "data": {"content": "hi"},
                   "timestamp": "2026-10-16T09:00:01.000Z"}),
        ],
    );
    Store::new(
        "copilot",
        vec![top.clone(), top.join("session-state"), session, events],
    )
}

/// VS Code Copilot Chat, also the `copilot` provider:
/// `<user data>/workspaceStorage/<hash>/chatSessions/<session>.json`.
fn copilot_vscode(home: &Path) -> Store {
    let user = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Code/User")
    } else {
        home.join(".config/Code/User")
    };
    let workspace = user.join("workspaceStorage/abc123");
    let folder = workspace.join("workspace.json");
    write_lines(&folder, &[json!({"folder": "file:///work/app"})]);
    let session = workspace.join("chatSessions/vs-1.json");
    write_lines(
        &session,
        &[
            json!({"sessionId": "vs-1", "creationDate": 1_760_605_200_000_u64,
                 "requests": [{"message": {"text": "hi"},
                               "response": [{"value": "ok"}]}]}),
        ],
    );
    Store::new(
        "copilot",
        vec![
            user.clone(),
            user.join("workspaceStorage"),
            workspace.clone(),
            folder,
            workspace.join("chatSessions"),
            session,
        ],
    )
}

/// Antigravity's rpc cache:
/// `~/.gemini/antigravity/.token-monitor/rpc-cache/v1/<session>/usage.jsonl`.
fn antigravity(home: &Path) -> Store {
    let root = home.join(".gemini/antigravity");
    let monitor = root.join(".token-monitor");
    let cache = monitor.join("rpc-cache/v1");
    let session = cache.join("sess-a1");
    let usage = session.join("usage.jsonl");
    write_lines(
        &usage,
        &[
            json!({"recordType": "usage", "sequence": 1, "model": "gemini-3-pro-high",
                 "inputTokens": 100, "outputTokens": 200,
                 "raw": {"chatModel": {"chatStartMetadata":
                                       {"createdAt": "2026-10-16T09:00:00Z"}}}}),
        ],
    );
    Store::new(
        "antigravity",
        vec![
            root,
            monitor.clone(),
            monitor.join("rpc-cache"),
            cache,
            session,
            usage,
        ],
    )
}

/// `~/.forge/.forge.db`.
fn forgecode(home: &Path) -> Store {
    let top = home.join(".forge");
    let db = top.join(".forge.db");
    fs::create_dir_all(&top).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
             title TEXT, context TEXT, metrics TEXT, created_at TEXT, updated_at TEXT);",
    )
    .unwrap();
    let context = json!({
        "conversation_id": "conv-1", "cwd": "/work/app",
        "messages": [
            {"Text": {"role": "user", "content": "hi", "timestamp": "2026-10-16T09:00:00Z"}},
            {"message": {"text": {"role": "Assistant", "content": "ok",
                                  "model": "forge-model-v1"}},
             "usage": {"prompt_tokens": {"actual": 120}, "completion_tokens": {"actual": 45}},
             "timestamp": "2026-10-16T09:00:01Z"}
        ]
    });
    conn.execute(
        "INSERT INTO conversations VALUES ('conv-1', 'ws-1', 'Demo', ?1, NULL,
             '2026-10-16T09:00:00Z', '2026-10-16T09:01:00Z')",
        [context.to_string()],
    )
    .unwrap();
    Store::new("forgecode", vec![top, db])
}

/// `~/.zcode/cli/db/db.sqlite`.
fn zcode(home: &Path) -> Store {
    let top = home.join(".zcode");
    let db_dir = top.join("cli/db");
    let db = db_dir.join("db.sqlite");
    fs::create_dir_all(&db_dir).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE session (id text primary key, project_id text not null,
             directory text not null, title text not null,
             task_type text default 'interactive', title_source text default 'first_input',
             parent_id text, time_created integer not null, time_updated integer not null,
             time_archived integer);
         CREATE TABLE message (id text primary key, session_id text not null,
             time_created integer not null, data text not null, sequence integer);
         CREATE TABLE part (id text primary key, message_id text not null,
             session_id text not null, time_created integer not null, data text not null,
             sequence integer);
         INSERT INTO session (id, project_id, directory, title, time_created, time_updated)
             VALUES ('sess-1', 'p', '/work/app', 'hi', 1788599956241, 1788599999999);
         INSERT INTO message (id, session_id, time_created, data, sequence)
             VALUES ('m1', 'sess-1', 1788599956241,
                     '{\"role\":\"user\",\"time\":{\"created\":1788599956241}}', 0);",
    )
    .unwrap();
    Store::new("zcode", vec![top.clone(), top.join("cli"), db_dir, db])
}

/// `$LLM_USER_PATH/logs.db`.
fn llm(home: &Path) -> Store {
    let dir = home.join("llm-user");
    let db = dir.join("logs.db");
    fs::create_dir_all(&dir).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT, model TEXT);
         CREATE TABLE responses (id TEXT PRIMARY KEY, model TEXT, prompt TEXT, response TEXT,
             conversation_id TEXT, datetime_utc TEXT, input_tokens INTEGER,
             output_tokens INTEGER);
         INSERT INTO conversations VALUES ('c1', 'Demo', 'gpt-4');
         INSERT INTO responses VALUES ('r1', 'gpt-4', 'hi', 'ok', 'c1',
             '2026-10-16T09:00:00', 12, 34);",
    )
    .unwrap();
    Store::new("llm", vec![dir.clone(), db]).with_env("LLM_USER_PATH", &dir)
}

/// `$CURSOR_USER_DIR/globalStorage/state.vscdb`.
fn cursor(home: &Path) -> Store {
    let user = home.join("cursor-user");
    let global = user.join("globalStorage");
    let db = global.join("state.vscdb");
    fs::create_dir_all(&global).unwrap();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch(
        "CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)",
    )
    .unwrap();
    let composer = json!({
        "composerId": "comp-1", "name": "Demo", "createdAt": 1_760_605_200_000_u64,
        "lastUpdatedAt": 1_760_605_260_000_u64, "isArchived": false, "unifiedMode": "agent",
        "workspaceIdentifier": {"id": "ws-1",
                                "uri": {"fsPath": "/work/app", "path": "/work/app"}},
        "fullConversationHeadersOnly": [{"bubbleId": "b1", "type": 1}],
        "promptTokenBreakdown": {"totalUsedTokens": 9001}
    });
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES ('composerData:comp-1', ?1)",
        [composer.to_string()],
    )
    .unwrap();
    Store::new("cursor", vec![user.clone(), global, db]).with_env("CURSOR_USER_DIR", &user)
}
