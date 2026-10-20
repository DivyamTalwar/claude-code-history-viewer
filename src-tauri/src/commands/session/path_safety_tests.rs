//! The session list, the subagent list, archives, the expiring-session list,
//! the project list and search stay inside the history folders (v1.32.1).
//!
//! A symlink planted below a Claude root is never followed: not a session
//! file, not a session's subagent folder (`<session>/` in the native layout,
//! `subagents/` in the archive layout). The root itself may be reached
//! through one (a symlinked `~/.claude`, #355, or a project folder that is a
//! link). Only regular files are opened: a directory named like a session
//! used to stall the session list, since every read of it fails and the
//! failure was retried, and a FIFO blocks the reader that opens it.

use super::{
    get_recent_edits, get_session_subagents, load_project_sessions, load_project_sessions_page,
    search_messages,
};
use crate::commands::{archive, multi_provider, project, stats};
use crate::models::ClaudeSession;
use crate::test_utils::SandboxHome;
use serial_test::serial;
use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tempfile::TempDir;

/// A user prompt `text` and a 100-token assistant reply in `session`.
fn transcript(session: &str, text: &str) -> String {
    let prompt = serde_json::json!({
        "type": "user", "sessionId": session, "uuid": format!("{session}-u"),
        "timestamp": "2026-10-15T12:00:00Z",
        "message": {"role": "user", "content": text}
    });
    let reply = serde_json::json!({
        "type": "assistant", "sessionId": session, "uuid": format!("{session}-a"),
        "timestamp": "2026-10-15T12:00:01Z",
        "message": {
            "id": format!("msg-{session}"), "role": "assistant",
            "model": "claude-sonnet-4-5-20250929",
            "content": [{"type": "text", "text": "reply"}],
            "usage": {"input_tokens": 100, "output_tokens": 0}
        }
    });
    format!("{prompt}\n{reply}\n")
}

fn write(path: &Path, session: &str, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, transcript(session, text)).unwrap();
}

fn mkfifo(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let made = std::process::Command::new("mkfifo")
        .arg(path)
        .status()
        .unwrap();
    assert!(made.success(), "mkfifo {}", path.display());
}

fn text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string()
}

/// `file: summary` for each listed session, sorted.
fn listed(sessions: &[ClaudeSession]) -> Vec<String> {
    let mut listed: Vec<String> = sessions
        .iter()
        .map(|session| {
            format!(
                "{}: {}",
                file_name(&session.file_path),
                session.summary.clone().unwrap_or_default()
            )
        })
        .collect();
    listed.sort();
    listed
}

/// `agent: summary` for each subagent the subagent list shows for `session`.
async fn subagents(session: &Path) -> Result<Vec<String>, String> {
    Ok(get_session_subagents(text(session))
        .await?
        .iter()
        .map(|agent| {
            format!(
                "{}: {}",
                agent.agent_id,
                agent.summary.clone().unwrap_or_default()
            )
        })
        .collect())
}

/// `file: subagent count` for each session the expiring list shows, sorted.
async fn expiring(project: &Path) -> Result<Vec<String>, String> {
    let mut expiring: Vec<String> = archive::get_expiring_sessions(text(project), 100_000)
        .await?
        .iter()
        .map(|entry| {
            format!(
                "{}: {}",
                file_name(&entry.session.file_path),
                entry.subagent_count
            )
        })
        .collect();
    expiring.sort();
    Ok(expiring)
}

/// The session files the expiring list shows, sorted.
async fn expiring_files(project: &Path) -> Result<Vec<String>, String> {
    let mut files: Vec<String> = archive::get_expiring_sessions(text(project), 100_000)
        .await?
        .iter()
        .map(|entry| file_name(&entry.session.file_path))
        .collect();
    files.sort();
    Ok(files)
}

/// Archive `sessions` of `project` with their subagents. The `*.jsonl` files
/// in the archive, relative to it, marked when they hold text from outside
/// the root.
async fn archived(project: &Path, sessions: &[PathBuf]) -> Result<Vec<String>, String> {
    let entry = archive::create_archive(
        "probe".to_string(),
        None,
        sessions.iter().map(|session| text(session)).collect(),
        "claude".to_string(),
        text(project),
        "p".to_string(),
        true,
    )
    .await?;
    let dir = archive::get_archives_dir()?.join(&entry.id);
    let mut files: Vec<String> = walkdir::WalkDir::new(&dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "jsonl"))
        .map(|entry| {
            let outside = fs::read_to_string(entry.path())
                .unwrap()
                .contains("outside");
            format!(
                "{}{}",
                entry.path().strip_prefix(&dir).unwrap().display(),
                if outside { " (outside)" } else { "" }
            )
        })
        .collect();
    files.sort();
    Ok(files)
}

/// The session count the project list shows for the project folder `name`.
async fn project_sessions(claude: &Path, name: &str) -> Result<Vec<usize>, String> {
    Ok(project::scan_projects(text(claude))
        .await?
        .iter()
        .filter(|project| file_name(&project.path) == name)
        .map(|project| project.session_count)
        .collect())
}

/// The sessions search finds `query` in, sorted.
async fn found(claude: &Path, query: &str) -> Result<Vec<String>, String> {
    let mut sessions: Vec<String> =
        search_messages(text(claude), query.to_string(), serde_json::json!({}), None)
            .await?
            .into_iter()
            .map(|message| message.session_id)
            .collect();
    sessions.sort();
    sessions.dedup();
    Ok(sessions)
}

/// Project `p` under a sandboxed `~/.claude`: sessions `s1` and `s2` inside
/// the root, `s2` with a subagent inside it. Links planted in the project
/// lead out of the root: a session file, `s1`'s native subagent folder and
/// the project's archive-layout subagent folder.
struct Planted {
    home: SandboxHome,
    outside: TempDir,
}

impl Planted {
    fn new() -> Self {
        let planted = Self {
            home: SandboxHome::new(),
            outside: TempDir::new().unwrap(),
        };
        let project = planted.project();
        let outside = planted.outside.path();
        write(&project.join("s1.jsonl"), "s1", "inside s1");
        write(&project.join("s2.jsonl"), "s2", "inside s2");
        write(
            &project.join("s2/subagents/agent-r.jsonl"),
            "s2",
            "inside s2's subagent",
        );
        write(&outside.join("private.jsonl"), "private", "outside file");
        write(
            &outside.join("native/subagents/agent-x.jsonl"),
            "s1",
            "outside native subagent",
        );
        write(
            &outside.join("archive/s1/agent-y.jsonl"),
            "s1",
            "outside archive subagent",
        );
        symlink(outside.join("private.jsonl"), project.join("escaped.jsonl")).unwrap();
        symlink(outside.join("native"), project.join("s1")).unwrap();
        symlink(outside.join("archive"), project.join("subagents")).unwrap();
        planted
    }

    fn claude(&self) -> PathBuf {
        self.home.path().join(".claude")
    }

    fn project(&self) -> PathBuf {
        self.claude().join("projects").join("p")
    }
}

/// The lists that read the session files of a project (or of every project)
/// never read one through a symlink.
#[tokio::test]
#[serial]
async fn the_session_lists_never_read_a_session_file_through_a_symlink() {
    let planted = Planted::new();
    let project = planted.project();

    let read = (
        load_project_sessions(text(&project), None)
            .await
            .map(|sessions| listed(&sessions)),
        multi_provider::load_provider_sessions("claude".to_string(), text(&project), None)
            .await
            .map(|sessions| listed(&sessions)),
        expiring_files(&project).await,
        project_sessions(&planted.claude(), "p").await,
        found(&planted.claude(), "file").await,
    );

    let sessions = Ok(vec![
        "agent-r.jsonl: inside s2's subagent".to_string(),
        "s1.jsonl: inside s1".to_string(),
        "s2.jsonl: inside s2".to_string(),
    ]);
    assert_eq!(
        read,
        (
            sessions.clone(),
            sessions,
            Ok(vec!["s1.jsonl".to_string(), "s2.jsonl".to_string()]),
            Ok(vec![2]),
            Ok(vec![]),
        )
    );
}

/// The root itself may be reached through a symlink: a symlinked `~/.claude`
/// (#355) and a project folder that is a link are read as before, subagent
/// folders included.
#[tokio::test]
#[serial]
async fn the_history_readers_still_read_a_root_reached_through_a_symlink() {
    let home = SandboxHome::new();
    let store = home.path().join("store");
    write(&store.join("projects/p/s1.jsonl"), "s1", "inside s1");
    write(
        &store.join("projects/p/s1/subagents/agent-a.jsonl"),
        "s1",
        "inside s1's subagent",
    );
    symlink(&store, home.path().join(".claude")).unwrap();
    symlink(store.join("projects/p"), store.join("projects/alias")).unwrap();

    let mut read = Vec::new();
    for project in ["p", "alias"].map(|name| home.path().join(".claude/projects").join(name)) {
        let s1 = project.join("s1.jsonl");
        read.push((
            load_project_sessions(text(&project), None)
                .await
                .map(|sessions| listed(&sessions)),
            subagents(&s1).await,
            expiring(&project).await,
            archived(&project, &[s1]).await,
        ));
    }

    let expected = (
        Ok(vec![
            "agent-a.jsonl: inside s1's subagent".to_string(),
            "s1.jsonl: inside s1".to_string(),
        ]),
        Ok(vec!["a: inside s1's subagent".to_string()]),
        Ok(vec!["s1.jsonl: 1".to_string()]),
        Ok(vec![
            "sessions/s1.jsonl".to_string(),
            "subagents/s1/agent-a.jsonl".to_string(),
        ]),
    );
    assert_eq!(read, [expected.clone(), expected]);
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

type Read = Box<dyn FnOnce() -> String + Send>;

/// Each reader on a thread of its own: its result, or `stalled` when it has
/// not returned in time. A stalled thread is left behind.
fn within_deadline(reads: Vec<(&'static str, Read)>) -> Vec<(&'static str, String)> {
    reads
        .into_iter()
        .map(|(reader, read)| {
            let (sent, received) = mpsc::channel();
            std::thread::spawn(move || sent.send(read()));
            let result = received
                .recv_timeout(Duration::from_secs(10))
                .unwrap_or_else(|_| "stalled".to_string());
            (reader, result)
        })
        .collect()
}

/// `read(path)` as a [`Read`], its result shown with `{:?}`.
fn read_path<T: std::fmt::Debug + 'static>(path: &Path, read: fn(PathBuf) -> T) -> Read {
    let path = path.to_path_buf();
    Box::new(move || format!("{:?}", read(path)))
}

/// A project `q` under a sandboxed `~/.claude` holding session `s9` and its
/// subagent `r`.
fn project_q(home: &SandboxHome) -> (PathBuf, PathBuf) {
    let project = home.path().join(".claude").join("projects").join("q");
    write(&project.join("s9.jsonl"), "s9", "inside s9");
    write(
        &project.join("s9/subagents/agent-r.jsonl"),
        "s9",
        "inside s9's subagent",
    );
    (project.clone(), project.join("s9.jsonl"))
}

/// The lists answer, and read only the regular files, with a directory, a
/// link to it and a FIFO named like a session in the project.
#[test]
#[serial]
fn the_session_lists_skip_entries_that_are_not_regular_files() {
    let home = SandboxHome::new();
    let (project, _) = project_q(&home);
    let claude = home.path().join(".claude");
    fs::create_dir_all(project.join("folder.jsonl")).unwrap();
    symlink(
        project.join("folder.jsonl"),
        project.join("folder-link.jsonl"),
    )
    .unwrap();
    mkfifo(&project.join("fifo.jsonl"));

    let read = within_deadline(vec![
        (
            "load_project_sessions",
            read_path(&project, |project| {
                block_on(load_project_sessions(text(&project), None)).map(|s| listed(&s))
            }),
        ),
        (
            "load_project_sessions_page",
            read_path(&project, |project| {
                block_on(load_project_sessions_page(text(&project), None, None, None))
                    .map(|page| listed(&page.sessions))
            }),
        ),
        (
            "get_expiring_sessions",
            read_path(&project, |project| block_on(expiring_files(&project))),
        ),
        (
            "scan_projects",
            read_path(&claude, |claude| block_on(project_sessions(&claude, "q"))),
        ),
        (
            "search_messages",
            read_path(&claude, |claude| block_on(found(&claude, "inside"))),
        ),
        (
            "get_recent_edits",
            read_path(&project, |project| {
                block_on(get_recent_edits(text(&project), None, None, None, None))
                    .map(|edits| edits.files.len())
            }),
        ),
        (
            "get_project_stats_summary",
            read_path(&project, |project| {
                block_on(stats::get_project_stats_summary(
                    text(&project),
                    None,
                    None,
                    None,
                ))
                .map(|summary| summary.total_tokens)
            }),
        ),
        (
            "get_global_stats_summary",
            read_path(&claude, |claude| {
                let claude_only = Some(vec!["claude".to_string()]);
                block_on(stats::get_global_stats_summary(
                    text(&claude),
                    claude_only,
                    None,
                    None,
                    None,
                    None,
                ))
                .map(|summary| summary.total_tokens)
            }),
        ),
    ]);

    let sessions = r#"Ok(["agent-r.jsonl: inside s9's subagent", "s9.jsonl: inside s9"])"#;
    assert_eq!(
        read,
        [
            ("load_project_sessions", sessions.to_string()),
            ("load_project_sessions_page", sessions.to_string()),
            ("get_expiring_sessions", r#"Ok(["s9.jsonl"])"#.to_string()),
            ("scan_projects", "Ok([1])".to_string()),
            ("search_messages", r#"Ok(["s9"])"#.to_string()),
            ("get_recent_edits", "Ok(0)".to_string()),
            ("get_project_stats_summary", "Ok(200)".to_string()),
            ("get_global_stats_summary", "Ok(200)".to_string()),
        ]
    );
}
