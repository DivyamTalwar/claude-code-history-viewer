//! Scope resolution (ADR 0002 §1, §7, §9): which session files a request
//! reads, per provider, and what could not be read.
//!
//! Claude reads the same roots and files as the old commands (default root +
//! custom roots for `all`, every `*.jsonl` under a project directory) through
//! the contribution cache; subagent transcripts are folded into the session
//! that spawned them (#577). Other providers go through their existing stats
//! paths per request.

use super::contribution::{
    from_antigravity_records, from_messages, read_claude_file, FileContributions,
};
use super::contribution_cache::contribution_cache;
use super::{ProviderScanStatus, UsageScope};
use crate::commands::stats::{
    all_stats_providers, claude_session_heads, detect_project_provider,
    load_antigravity_usage_records, load_stats_messages, load_stats_sessions, scan_stats_projects,
    stats_provider_id, StatsMode, StatsProvider,
};
use crate::models::ClaudeSession;
use rayon::prelude::*;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use walkdir::WalkDir;

/// Whether the provider's history format carries token usage at all. A
/// provider without it is reported `not_supported` (never as zero usage) and
/// is not scanned. Exhaustive on purpose: a new provider must decide.
pub(super) fn reports_token_usage(provider: StatsProvider) -> bool {
    use StatsProvider as P;
    match provider {
        P::Claude
        | P::Antigravity
        | P::Cline
        | P::Codex
        | P::Copilot
        | P::Cursor
        | P::ForgeCode
        | P::Gemini
        | P::Grok
        | P::Kilo
        | P::Kimi
        | P::Llm
        | P::Ompi
        | P::OpenCode
        | P::OpenInterpreter
        | P::Pi
        | P::Qwen
        | P::Zcode => true,
        P::Aider
        | P::AmazonQ
        | P::Codebuddy
        | P::Continue
        | P::Crush
        | P::CursorAgent
        | P::Goose
        | P::Kiro
        | P::OpenHands
        | P::PearAI
        | P::Trae
        | P::Vibe
        | P::Zed => false,
    }
}

/// Whether the provider marks sidechain (subagent) rows, so that
/// `conversation_only` can exclude anything.
pub(super) fn records_sidechains(provider: StatsProvider) -> bool {
    matches!(provider, StatsProvider::Claude | StatsProvider::Zcode)
}

/// Strict provider id parse: an unknown id is a request error.
pub(super) fn parse_provider_id(id: &str) -> Result<StatsProvider, String> {
    all_stats_providers()
        .into_iter()
        .find(|provider| stats_provider_id(*provider) == id)
        .ok_or_else(|| format!("usage breakdown: unknown provider '{id}'"))
}

/// The validated scope, resolved before any file is read.
#[derive(Debug, Clone)]
pub(super) enum ScopePlan {
    Project {
        provider: StatsProvider,
        project_path: String,
    },
    All {
        /// Request order, duplicates dropped.
        providers: Vec<StatsProvider>,
        claude_path: String,
        custom_claude_paths: Vec<String>,
    },
}

impl ScopePlan {
    pub fn parse(scope: &UsageScope) -> Result<Self, String> {
        match scope {
            UsageScope::Project {
                project_path,
                provider,
            } => {
                let provider = parse_provider_id(provider)?;
                let detected = detect_project_provider(project_path);
                if detected != provider {
                    return Err(format!(
                        "usage breakdown: project '{project_path}' belongs to provider '{}', not '{}'",
                        stats_provider_id(detected),
                        stats_provider_id(provider)
                    ));
                }
                if provider == StatsProvider::Claude {
                    if project_path.trim().is_empty() {
                        return Err("project_path is required".to_string());
                    }
                    if !Path::new(project_path).is_absolute() {
                        return Err("project_path must be absolute".to_string());
                    }
                }
                Ok(Self::Project {
                    provider,
                    project_path: project_path.clone(),
                })
            }
            UsageScope::All {
                providers,
                claude_path,
                custom_claude_paths,
            } => {
                let mut parsed = Vec::with_capacity(providers.len());
                for id in providers {
                    let provider = parse_provider_id(id)?;
                    if !parsed.contains(&provider) {
                        parsed.push(provider);
                    }
                }
                Ok(Self::All {
                    providers: parsed,
                    claude_path: claude_path.clone(),
                    custom_claude_paths: custom_claude_paths
                        .iter()
                        .map(|custom| custom.path.clone())
                        .collect(),
                })
            }
        }
    }
}

/// One session of the response: its files' contributions and identity.
pub(super) struct SessionInput {
    pub provider: StatsProvider,
    pub file_path: String,
    pub project_path: String,
    /// Head transcript first, then the subagent transcripts folded into it.
    pub files: Vec<Arc<FileContributions>>,
    /// Used when no accepted row names a session id.
    pub fallback_session_id: String,
    pub title: Option<String>,
}

impl SessionInput {
    pub fn session_id(&self) -> String {
        self.files
            .iter()
            .find_map(|file| file.session_id.clone())
            .unwrap_or_else(|| self.fallback_session_id.clone())
    }
}

/// What one provider's scan read and failed to read (ADR §9).
#[derive(Debug, Clone)]
pub(super) struct ProviderScan {
    pub provider: StatsProvider,
    pub sessions_scanned: u64,
    pub sessions_failed: u64,
    /// Roots, project lists or session lists that could not be read at all.
    pub sources_failed: u64,
    pub not_supported: bool,
}

impl ProviderScan {
    fn new(provider: StatsProvider) -> Self {
        Self {
            provider,
            sessions_scanned: 0,
            sessions_failed: 0,
            sources_failed: 0,
            not_supported: !reports_token_usage(provider),
        }
    }

    pub fn status(&self) -> ProviderScanStatus {
        if self.not_supported {
            return ProviderScanStatus::NotSupported;
        }
        match (
            self.sessions_failed + self.sources_failed,
            self.sessions_scanned,
        ) {
            (0, _) => ProviderScanStatus::Scanned,
            (_, 0) => ProviderScanStatus::Unreadable,
            _ => ProviderScanStatus::Partial,
        }
    }
}

/// Everything a request reads.
pub(super) struct Collected {
    pub sessions: Vec<SessionInput>,
    pub scans: Vec<ProviderScan>,
}

pub(super) fn collect(plan: &ScopePlan, mode: StatsMode) -> Collected {
    let mut collected = Collected {
        sessions: Vec::new(),
        scans: Vec::new(),
    };
    match plan {
        ScopePlan::Project {
            provider,
            project_path,
        } => {
            let mut scan = ProviderScan::new(*provider);
            if !scan.not_supported {
                let sessions = if *provider == StatsProvider::Claude {
                    collect_claude(
                        claude_project_files(Path::new(project_path), project_path, &mut scan)
                            .into_iter()
                            .collect(),
                        mode,
                        &mut scan,
                    )
                } else {
                    let tasks = match load_stats_sessions(*provider, project_path) {
                        Ok(sessions) => sessions
                            .into_iter()
                            .map(|session| (project_path.clone(), session))
                            .collect(),
                        Err(error) => {
                            log::warn!("usage breakdown: {project_path}: {error}");
                            scan.sources_failed += 1;
                            Vec::new()
                        }
                    };
                    collect_provider_sessions(*provider, tasks, mode, &mut scan)
                };
                collected.sessions.extend(sessions);
            }
            collected.scans.push(scan);
        }
        ScopePlan::All {
            providers,
            claude_path,
            custom_claude_paths,
        } => {
            for provider in providers {
                let mut scan = ProviderScan::new(*provider);
                if !scan.not_supported {
                    let sessions = if *provider == StatsProvider::Claude {
                        let projects =
                            claude_root_projects(claude_path, custom_claude_paths, &mut scan);
                        collect_claude(projects, mode, &mut scan)
                    } else {
                        let tasks = provider_all_sessions(*provider, &mut scan);
                        collect_provider_sessions(*provider, tasks, mode, &mut scan)
                    };
                    collected.sessions.extend(sessions);
                }
                collected.scans.push(scan);
            }
        }
    }
    collected
}

// ---- Claude -----------------------------------------------------------------

/// One Claude project directory and its `*.jsonl` files.
struct ClaudeProjectFiles {
    project_path: String,
    files: Vec<PathBuf>,
}

fn claude_project_files(
    project_dir: &Path,
    project_path: &str,
    scan: &mut ProviderScan,
) -> Option<ClaudeProjectFiles> {
    if !project_dir.is_dir() {
        log::warn!("usage breakdown: Claude project '{project_path}' is not a readable directory");
        scan.sources_failed += 1;
        return None;
    }
    // Same file set as the old project stats: any `*.jsonl` entry, so a
    // non-file named like a session surfaces as a failed session.
    let files = WalkDir::new(project_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .map(|entry| entry.path().to_path_buf())
        .collect();
    Some(ClaudeProjectFiles {
        project_path: project_path.to_string(),
        files,
    })
}

/// The projects of the default root and every valid custom root, each root
/// read once even when listed twice.
fn claude_root_projects(
    claude_path: &str,
    custom_claude_paths: &[String],
    scan: &mut ProviderScan,
) -> Vec<ClaudeProjectFiles> {
    let mut roots = vec![PathBuf::from(claude_path)];
    for custom in custom_claude_paths {
        let base = PathBuf::from(custom);
        match crate::utils::validate_custom_claude_path(&base) {
            Ok(_) => roots.push(base),
            Err(error) => {
                log::warn!("usage breakdown: skipping custom Claude path: {error}");
                scan.sources_failed += 1;
            }
        }
    }
    let mut seen_roots = HashSet::new();
    let mut projects = Vec::new();
    for root in roots {
        let projects_dir = root.join("projects");
        let identity = fs::canonicalize(&projects_dir).unwrap_or_else(|_| projects_dir.clone());
        if !seen_roots.insert(identity) {
            continue;
        }
        let entries = match fs::read_dir(&projects_dir) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!(
                    "usage breakdown: cannot read {}: {error}",
                    projects_dir.display()
                );
                scan.sources_failed += 1;
                continue;
            }
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            let project_path = dir.to_string_lossy().to_string();
            projects.extend(claude_project_files(&dir, &project_path, scan));
        }
    }
    projects
}

/// Load every file through the cache in parallel, then group transcripts
/// into sessions (a session fails when any of its transcripts fails).
fn collect_claude(
    projects: Vec<ClaudeProjectFiles>,
    mode: StatsMode,
    scan: &mut ProviderScan,
) -> Vec<SessionInput> {
    let all_files: Vec<&PathBuf> = projects.iter().flat_map(|p| &p.files).collect();
    let loaded: HashMap<&PathBuf, Result<Arc<FileContributions>, String>> = all_files
        .par_iter()
        .map(|path| {
            let result =
                contribution_cache().get_or_load(path, mode, || read_claude_file(path, mode));
            (*path, result)
        })
        .collect();

    let mut sessions = Vec::new();
    for project in &projects {
        let in_project: HashSet<&PathBuf> = project.files.iter().collect();
        for head in claude_session_heads(project.files.clone()) {
            let subagents = crate::utils::find_subagent_files(&head);
            let paths = std::iter::once(&head)
                .chain(subagents.iter().filter(|path| in_project.contains(path)));
            let mut files = Vec::new();
            let mut failed = false;
            for path in paths {
                match loaded.get(path) {
                    Some(Ok(file)) => files.push(Arc::clone(file)),
                    Some(Err(error)) => {
                        log::warn!("usage breakdown: {error}");
                        failed = true;
                    }
                    None => failed = true,
                }
            }
            if failed {
                scan.sessions_failed += 1;
            } else {
                scan.sessions_scanned += 1;
            }
            if files.is_empty() {
                continue;
            }
            let title = files.first().and_then(|file| file.title.clone());
            sessions.push(SessionInput {
                provider: StatsProvider::Claude,
                file_path: head.to_string_lossy().to_string(),
                project_path: project.project_path.clone(),
                fallback_session_id: head
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or_default()
                    .to_string(),
                title,
                files,
            });
        }
    }
    sessions
}

// ---- other providers ----------------------------------------------------------

/// Every (project path, session) of a provider, as the old global stats list them.
fn provider_all_sessions(
    provider: StatsProvider,
    scan: &mut ProviderScan,
) -> Vec<(String, ClaudeSession)> {
    if provider == StatsProvider::Antigravity {
        let Some(root) = crate::commands::antigravity::resolve_antigravity_root() else {
            scan.sources_failed += 1;
            return Vec::new();
        };
        let root = root.to_string_lossy().to_string();
        return match load_stats_sessions(provider, &root) {
            Ok(sessions) => sessions.into_iter().map(|s| (root.clone(), s)).collect(),
            Err(error) => {
                log::warn!("usage breakdown: antigravity: {error}");
                scan.sources_failed += 1;
                Vec::new()
            }
        };
    }
    let projects = match scan_stats_projects(provider) {
        Ok(projects) => projects,
        Err(error) => {
            log::warn!("usage breakdown: {}: {error}", stats_provider_id(provider));
            scan.sources_failed += 1;
            return Vec::new();
        }
    };
    let mut tasks = Vec::new();
    for project in projects {
        match load_stats_sessions(provider, &project.path) {
            Ok(sessions) => tasks.extend(sessions.into_iter().map(|s| (project.path.clone(), s))),
            Err(error) => {
                log::warn!("usage breakdown: {}: {error}", project.path);
                scan.sources_failed += 1;
            }
        }
    }
    tasks
}

fn collect_provider_sessions(
    provider: StatsProvider,
    tasks: Vec<(String, ClaudeSession)>,
    mode: StatsMode,
    scan: &mut ProviderScan,
) -> Vec<SessionInput> {
    let results: Vec<(String, ClaudeSession, Result<FileContributions, String>)> = tasks
        .into_par_iter()
        .map(|(project_path, session)| {
            let result = load_provider_session(provider, &session, mode);
            (project_path, session, result)
        })
        .collect();
    let mut sessions = Vec::new();
    for (project_path, session, result) in results {
        match result {
            Ok(file) => {
                scan.sessions_scanned += 1;
                sessions.push(SessionInput {
                    provider,
                    file_path: session.file_path,
                    project_path,
                    files: vec![Arc::new(file)],
                    fallback_session_id: session.actual_session_id,
                    title: session.summary,
                });
            }
            Err(error) => {
                log::warn!("usage breakdown: {}: {error}", session.file_path);
                scan.sessions_failed += 1;
            }
        }
    }
    sessions
}

fn load_provider_session(
    provider: StatsProvider,
    session: &ClaudeSession,
    mode: StatsMode,
) -> Result<FileContributions, String> {
    if provider == StatsProvider::Antigravity {
        let records = load_antigravity_usage_records(&session.file_path)?;
        return Ok(from_antigravity_records(
            &records,
            mode,
            &session.actual_session_id,
            session.summary.clone(),
        ));
    }
    let messages = load_stats_messages(provider, &session.file_path)?;
    Ok(from_messages(&messages, mode, session.summary.clone()))
}
