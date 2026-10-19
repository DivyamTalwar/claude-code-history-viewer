//! The Claude session files a stats scan reads, found without following a
//! symlink (src-tauri security rule; backported from #691).
//!
//! One walk for every Claude stats command: every `*.jsonl` entry under a
//! project directory that is not a symlink. The walk root itself may be
//! reached through a symlink (a symlinked `~/.claude`, #355): the caller
//! authorizes the root, and the HTTP route judges it by its canonical path.
//! Nothing inside the root is followed. What a walk skipped or could not read
//! is returned, so the caller can say so.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

fn has_session_extension(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()) == Some("jsonl")
}

/// What a walk of one Claude project directory found.
#[derive(Debug, Default)]
pub(crate) struct SessionFileWalk {
    /// Every `*.jsonl` entry that is not a symlink, in walk order. As in the
    /// old scans, a directory named like a session is kept, so it surfaces
    /// as a failed read instead of disappearing.
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
}
