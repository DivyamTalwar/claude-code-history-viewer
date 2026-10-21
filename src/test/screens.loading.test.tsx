import { act, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { EmptyScreen } from "@/layouts/shell/screens";
import { ProjectTree } from "@/components/ProjectTree";
import { useAppStore } from "@/store/useAppStore";
import type { ClaudeProject } from "@/types";

const initial = useAppStore.getState();
const project: ClaudeProject = {
  name: "Loaded project", path: "/history/project", actual_path: "/work/project",
  session_count: 1, message_count: 1, last_modified: "2026-10-01T00:00:00Z", provider: "claude",
};

function Tree({ phone = false }: { phone?: boolean }) {
  const projects = useAppStore((s) => s.projects);
  const loading = useAppStore((s) => s.isLoading);
  return <ProjectTree projects={projects} sessions={[]} selectedProject={null} selectedSession={null}
    onProjectSelect={vi.fn()} onSessionSelect={vi.fn()} onGlobalStatsClick={vi.fn()}
    isLoading={loading} asideId={phone ? "mobile-project-explorer" : "project-explorer"}
    onClose={phone ? vi.fn() : undefined} />;
}

function expectNoFalseEmpty() {
  for (const key of ["session.select", "session.selectDescription", "session.noProjects.title", "session.noProjects.claudeTitle", "project.notFound"]) {
    expect(screen.queryByText(i18n.t(key))).not.toBeInTheDocument();
  }
}

describe("loading truth in main area and project explorer", () => {
  beforeAll(async () => { await i18n.changeLanguage("en"); });
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ ...initial, projects: [], isLoading: false, isLoadingProjects: false,
      isDetectingProviders: false, projectsScanned: true, error: null });
  });
  afterAll(() => { useAppStore.setState(initial); });

  it.each(["isLoading", "isLoadingProjects", "isDetectingProviders"] as const)("main: %s is unknown, not a selection or empty prompt", (flag) => {
    useAppStore.setState({ [flag]: true });
    const { container } = render(<EmptyScreen />);
    expectNoFalseEmpty();
    expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"] .animate-shimmer').length).toBeGreaterThan(0);
    expect(container.querySelector('[role="alert"], [aria-live]')).not.toBeInTheDocument();
    act(() => useAppStore.setState({ [flag]: false }));
    expect(screen.getByRole("heading", { name: i18n.t("session.noProjects.claudeTitle") })).toBeInTheDocument();
  });

  it("main: pending → content → refresh keeps the resolved selection prompt", () => {
    useAppStore.setState({ isLoadingProjects: true });
    render(<EmptyScreen />);
    expectNoFalseEmpty();
    act(() => useAppStore.setState({ projects: [project], isLoadingProjects: false }));
    expect(screen.getByText(i18n.t("session.select"))).toBeInTheDocument();
    act(() => useAppStore.setState({ isLoadingProjects: true }));
    expect(screen.getByText(i18n.t("session.select"))).toBeInTheDocument();
  });

  it.each([false, true])("explorer (phone=%s): pending has neither false empty nor zero count; settled empty has both", (phone) => {
    useAppStore.setState({ isLoadingProjects: true });
    const { container } = render(<Tree phone={phone} />);
    expectNoFalseEmpty();
    const region = screen.getByRole("region", { name: i18n.t("project.projects") });
    expect(within(region).queryByText("0")).not.toBeInTheDocument();
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector('[aria-hidden="true"] .animate-shimmer')).toBeInTheDocument();
    act(() => useAppStore.setState({ isLoadingProjects: false }));
    expect(within(region).getByText("0")).toBeInTheDocument();
    expect(within(region).getByText(i18n.t("session.noProjects.claudeTitle"))).toBeInTheDocument();
  });

  it("explorer: refresh retains existing rows and their known count", () => {
    useAppStore.setState({ projects: [project] });
    render(<Tree />);
    expect(screen.getByRole("treeitem", { name: /project/ })).toBeInTheDocument();
    act(() => useAppStore.setState({ isLoadingProjects: true }));
    expect(screen.getByRole("treeitem", { name: /project/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: i18n.t("project.projects") }).parentElement).toHaveTextContent("1");
  });
});
