//! The Claude session files a stats scan reads, found without following a
//! symlink (src-tauri security rule; backported from #691).
//!
//! One walk for every Claude stats command and history reader (session
//! list, project list, search, recent edits): every `*.jsonl` entry under a
//! project directory that is not a symlink. The walk root itself may be
//! reached through a symlink (a symlinked `~/.claude`, #355): the caller
//! authorizes the root, and the HTTP route judges it by its canonical path.
//! Nothing inside the root is followed. What a walk skipped or could not read
//! is returned, so the caller can say so.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

fn has_session_extension(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()) == Some("jsonl")
}

/// What a walk of one Claude project directory found.
#[derive(Debug, Default)]
pub(crate) struct SessionFileWalk {
    /// Every `*.jsonl` entry that is not a symlink, in walk order. As in the
    /// old scans, a directory named like a session is kept, so a scan can
    /// report it; a reader opens [`regular_session_files`] only.
    pub files: Vec<PathBuf>,
    /// `*.jsonl` entries that are symlinks: never followed, never read.
    pub links: Vec<PathBuf>,
    /// Entries the walk could not read (an unreadable directory, an I/O
    /// error).
    pub errors: Vec<String>,
}

/// Every `*.jsonl` entry under `project_dir`, symlinks never followed.
pub(crate) fn walk_session_files(project_dir: &Path) -> SessionFileWalk {
    let mut walk = SessionFileWalk::default();
    for entry in WalkDir::new(project_dir).follow_links(false) {
        match entry {
            Ok(entry) if !has_session_extension(entry.path()) => {}
            Ok(entry) if entry.path_is_symlink() => walk.links.push(entry.into_path()),
            Ok(entry) => walk.files.push(entry.into_path()),
            Err(error) => walk.errors.push(error.to_string()),
        }
    }
    walk
}

/// Whether `path` is a regular file, judged without following a symlink:
/// the only kind of entry a history reader opens. A symlink can lead out of
/// the root, a directory named like a session fails every read (which a
/// line reader used to retry forever), and a FIFO blocks the reader that
/// opens it.
pub(crate) fn is_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// The session files a history reader opens under `project_dir`: the walk's
/// files that are regular files. The walk keeps a directory named like a
/// session, so that a scan can report it; a reader never opens one.
pub(crate) fn regular_session_files(project_dir: &Path) -> Vec<PathBuf> {
    walk_session_files(project_dir)
        .files
        .into_iter()
        .filter(|path| is_regular_file(path))
        .collect()
}

/// The project directories directly under a Claude `projects/` folder.
#[derive(Debug, Default)]
pub(crate) struct ProjectDirs {
    /// Real directories, sorted.
    pub dirs: Vec<PathBuf>,
    /// Symlinks to directories: never walked.
    pub links: Vec<PathBuf>,
    /// Entries that could not be read.
    pub errors: Vec<String>,
}

/// List the project directories of `projects_dir` without following a
/// symlink. A symlink to a directory is returned in `links` (the old scans
/// walked it as a project); anything else that is not a directory is not a
/// project.
pub(crate) fn claude_project_dirs(projects_dir: &Path) -> io::Result<ProjectDirs> {
    let mut listing = ProjectDirs::default();
    for entry in fs::read_dir(projects_dir)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                listing
                    .errors
                    .push(format!("{}: {error}", projects_dir.display()));
                continue;
            }
        };
        let path = entry.path();
        // `DirEntry::file_type` does not follow a symlink.
        match entry.file_type() {
            Ok(file_type) if file_type.is_symlink() => {
                if path.is_dir() {
                    listing.links.push(path);
                }
            }
            Ok(file_type) if file_type.is_dir() => listing.dirs.push(path),
            Ok(_) => {}
            Err(error) => listing.errors.push(format!("{}: {error}", path.display())),
        }
    }
    listing.dirs.sort();
    listing.links.sort();
    Ok(listing)
}

/// The subagent transcripts folded into `session` (#577), as
/// `utils::find_subagent_files` finds them, keeping only those reached
/// without a symlink below the session's folder. That lookup refuses a
/// symlinked `subagents` folder and a symlinked transcript, but resolves a
/// symlinked folder on the way to them (`<session>/` in the native layout,
/// `subagents/` in the archive layout), which can lead out of the root just
/// as a symlinked session file does.
pub(crate) fn subagent_files(session: &Path) -> Vec<PathBuf> {
    let Some(dir) = session.parent() else {
        return Vec::new();
    };
    crate::utils::find_subagent_files(session)
        .into_iter()
        .filter(|file| reached_without_a_symlink(dir, file))
        .collect()
}

/// Whether `path` lies below `dir` through real entries only: every component
/// after `dir` is a plain name and none of them is a symlink. `dir` itself may
/// be reached through one, as the walk root may.
fn reached_without_a_symlink(dir: &Path, path: &Path) -> bool {
    let Ok(below) = path.strip_prefix(dir) else {
        return false;
    };
    let mut current = dir.to_path_buf();
    below.components().all(|component| match component {
        Component::Normal(name) => {
            current.push(name);
            fs::symlink_metadata(&current).is_ok_and(|meta| !meta.file_type().is_symlink())
        }
        _ => false,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "{}\n").unwrap();
    }

    #[test]
    fn the_walk_lists_session_files_and_never_follows_a_link() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let project = dir.path().join("p");
        touch(&project.join("a.jsonl"));
        touch(&project.join("a/subagents/agent-1.jsonl"));
        touch(&project.join("notes.txt"));
        touch(&outside.path().join("x.jsonl"));
        symlink(outside.path().join("x.jsonl"), project.join("link.jsonl")).unwrap();
        symlink(outside.path(), project.join("linked-dir")).unwrap();

        let walk = walk_session_files(&project);
        let mut files = walk.files.clone();
        files.sort();
        assert_eq!(
            files,
            [
                project.join("a/subagents/agent-1.jsonl"),
                project.join("a.jsonl")
            ]
        );
        assert_eq!(walk.links, [project.join("link.jsonl")]);
        assert_eq!(walk.errors, Vec::<String>::new());
    }

    /// A reader opens regular files only: not a link, not a directory named
    /// like a session (the walk keeps it), not a FIFO.
    #[test]
    fn readers_open_the_regular_session_files_only() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("p");
        touch(&project.join("a.jsonl"));
        touch(&project.join("a/subagents/agent-1.jsonl"));
        fs::create_dir_all(project.join("folder.jsonl")).unwrap();
        symlink(project.join("a.jsonl"), project.join("link.jsonl")).unwrap();
        let fifo = project.join("fifo.jsonl");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());

        let mut walked = walk_session_files(&project).files;
        walked.sort();
        let mut read = regular_session_files(&project);
        read.sort();
        assert_eq!(
            walked,
            [
                project.join("a/subagents/agent-1.jsonl"),
                project.join("a.jsonl"),
                fifo,
                project.join("folder.jsonl"),
            ]
        );
        assert_eq!(
            read,
            [
                project.join("a/subagents/agent-1.jsonl"),
                project.join("a.jsonl")
            ]
        );
    }

    #[test]
    fn project_listing_separates_directories_from_links() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let projects = dir.path().join("projects");
        fs::create_dir_all(projects.join("b")).unwrap();
        fs::create_dir_all(projects.join("a")).unwrap();
        touch(&projects.join("stray.jsonl"));
        symlink(outside.path(), projects.join("evil")).unwrap();
        symlink(outside.path().join("missing"), projects.join("dangling")).unwrap();

        let listing = claude_project_dirs(&projects).unwrap();
        assert_eq!(listing.dirs, [projects.join("a"), projects.join("b")]);
        assert_eq!(listing.links, [projects.join("evil")]);
        assert_eq!(listing.errors, Vec::<String>::new());
    }

    #[test]
    fn subagent_files_keep_real_folders_and_refuse_a_symlinked_one() {
        let dir = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let project = dir.path().join("p");
        // s1: both layouts, real folders.
        touch(&project.join("s1.jsonl"));
        touch(&project.join("s1/subagents/agent-1.jsonl"));
        touch(&project.join("subagents/s1/agent-2.jsonl"));
        // s2: the native `<session>/` folder is a link out of the root.
        touch(&project.join("s2.jsonl"));
        touch(&outside.path().join("native/subagents/agent-3.jsonl"));
        symlink(outside.path().join("native"), project.join("s2")).unwrap();
        // s3 in q: the archive `subagents/` folder is a link out of the root.
        let other = dir.path().join("q");
        touch(&other.join("s3.jsonl"));
        touch(&outside.path().join("archive/s3/agent-4.jsonl"));
        symlink(outside.path().join("archive"), other.join("subagents")).unwrap();

        assert_eq!(
            subagent_files(&project.join("s1.jsonl")),
            [
                project.join("s1/subagents/agent-1.jsonl"),
                project.join("subagents/s1/agent-2.jsonl")
            ]
        );
        for (session, found_by_lookup) in
            [(project.join("s2.jsonl"), 1), (other.join("s3.jsonl"), 1)]
        {
            // The lookup alone resolves the folder link; the stats never do.
            assert_eq!(
                crate::utils::find_subagent_files(&session).len(),
                found_by_lookup,
                "{}",
                session.display()
            );
            assert_eq!(
                subagent_files(&session),
                Vec::<PathBuf>::new(),
                "{}",
                session.display()
            );
        }
    }

    /// The project directory itself may be reached through a symlink (the walk
    /// root): its subagent folders are still read.
    #[test]
    fn subagent_files_of_a_project_reached_through_a_symlink() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("p");
        touch(&project.join("s1.jsonl"));
        touch(&project.join("s1/subagents/agent-1.jsonl"));
        let linked = dir.path().join("linked");
        symlink(&project, &linked).unwrap();

        assert_eq!(
            subagent_files(&linked.join("s1.jsonl")),
            [linked.join("s1/subagents/agent-1.jsonl")]
        );
    }

    /// A session file named `...jsonl` has the stem `..`: the lookup then
    /// names folders beside the project, which are not the session's.
    #[test]
    fn subagent_files_never_leave_the_session_folder_by_name() {
        let dir = TempDir::new().unwrap();
        let project = dir.path().join("projects/p");
        touch(&project.join("...jsonl"));
        touch(&dir.path().join("projects/subagents/agent-1.jsonl"));

        assert_eq!(
            crate::utils::find_subagent_files(&project.join("...jsonl")).len(),
            1
        );
        assert_eq!(
            subagent_files(&project.join("...jsonl")),
            Vec::<PathBuf>::new()
        );
    }
}
