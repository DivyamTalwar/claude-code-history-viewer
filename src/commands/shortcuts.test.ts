import { afterEach, describe, expect, it, vi } from "vitest";
import { createShortcutHandler } from "./shortcuts";
import { COMMANDS, type CommandActions, type CommandContext } from "./registry";
import type { KeyEnvironment } from "./keys";
import type { CommandId } from "./manifest";

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const actions: CommandActions = {
    openPalette: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    focusFind: vi.fn(),
    toggleNavigator: vi.fn(),
    toggleMinimap: vi.fn(),
    openSettingsManager: vi.fn(),
    openArchive: vi.fn(),
    openFeedback: vi.fn(),
    checkForUpdates: vi.fn(),
  };
  return {
    place: {
      view: "conversation",
      project: { provider: "claude", path: "/p" },
      session: { provider: "claude", filePath: "/p/s.jsonl", sessionId: "s" },
    },
    runtime: "desktop",
    isMobile: false,
    canGoBack: true,
    canGoForward: true,
    hasFindTarget: true,
    ownPlace: () => () => true,
    actions,
    ...overrides,
  };
}

function setup(env: KeyEnvironment, ctx = makeContext(), nativeOwned?: ReadonlySet<CommandId>) {
  const handler = createShortcutHandler({ commands: COMMANDS, env, getContext: () => ctx, nativeOwned });
  window.addEventListener("keydown", handler);
  cleanups.push(() => window.removeEventListener("keydown", handler));
  return ctx;
}

const cleanups: Array<() => void> = [];

const press = (init: KeyboardEventInit, target: EventTarget = window) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};

const MAC_DESKTOP: KeyEnvironment = { os: "mac", runtime: "desktop" };
const WIN_DESKTOP: KeyEnvironment = { os: "win", runtime: "desktop" };
const MAC_WEB: KeyEnvironment = { os: "mac", runtime: "web" };

describe("shortcut handler", () => {
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
    document.body.innerHTML = "";
  });

  describe("platform mapping", () => {
    it("uses ⌘[ ⌘] for back/forward in the Mac app", () => {
      const ctx = setup(MAC_DESKTOP);
      press({ key: "[", code: "BracketLeft", metaKey: true });
      press({ key: "]", code: "BracketRight", metaKey: true });
      expect(ctx.actions.goBack).toHaveBeenCalledTimes(1);
      expect(ctx.actions.goForward).toHaveBeenCalledTimes(1);
    });

    it("ignores Ctrl in place of ⌘ on macOS", () => {
      const ctx = setup(MAC_DESKTOP);
      press({ key: "k", code: "KeyK", ctrlKey: true });
      press({ key: "[", code: "BracketLeft", ctrlKey: true });
      expect(ctx.actions.openPalette).not.toHaveBeenCalled();
      expect(ctx.actions.goBack).not.toHaveBeenCalled();
    });

    it("uses Ctrl and Alt+Arrow on Windows", () => {
      const ctx = setup(WIN_DESKTOP);
      press({ key: "k", code: "KeyK", ctrlKey: true });
      press({ key: "k", code: "KeyK", metaKey: true });
      press({ key: "ArrowLeft", altKey: true });
      expect(ctx.actions.openPalette).toHaveBeenCalledTimes(1);
      expect(ctx.actions.goBack).toHaveBeenCalledTimes(1);
    });
  });

  describe("WebUI fallback keys", () => {
    it("leaves ⌘[ ⌘] to the browser and takes ⌥←→ instead", () => {
      const ctx = setup(MAC_WEB);
      const browserBack = press({ key: "[", code: "BracketLeft", metaKey: true });
      expect(browserBack.defaultPrevented).toBe(false);
      expect(ctx.actions.goBack).not.toHaveBeenCalled();
      press({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });
      press({ key: "ArrowRight", code: "ArrowRight", altKey: true });
      expect(ctx.actions.goBack).toHaveBeenCalledTimes(1);
      expect(ctx.actions.goForward).toHaveBeenCalledTimes(1);
    });

    it("keeps ⌘K and ⌘F on macOS browsers", () => {
      const ctx = setup(MAC_WEB);
      press({ key: "k", code: "KeyK", metaKey: true });
      press({ key: "f", code: "KeyF", metaKey: true });
      expect(ctx.actions.openPalette).toHaveBeenCalledTimes(1);
      expect(ctx.actions.focusFind).toHaveBeenCalledTimes(1);
    });
  });

  describe("focus and composition", () => {
    it("ignores every shortcut while an IME is composing", () => {
      const ctx = setup(MAC_DESKTOP);
      press({ key: "k", code: "KeyK", metaKey: true, isComposing: true });
      press({ key: "f", code: "KeyF", metaKey: true, keyCode: 229 } as KeyboardEventInit);
      expect(ctx.actions.openPalette).not.toHaveBeenCalled();
      expect(ctx.actions.focusFind).not.toHaveBeenCalled();
    });

    it("leaves Alt+Arrow to a text field (word movement)", () => {
      const ctx = setup(WIN_DESKTOP);
      const input = document.body.appendChild(document.createElement("input"));
      const event = press({ key: "ArrowLeft", altKey: true }, input);
      expect(ctx.actions.goBack).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("lets ⌘F and ⌘K through from a text field, as intended", () => {
      const ctx = setup(MAC_DESKTOP);
      const input = document.body.appendChild(document.createElement("textarea"));
      press({ key: "f", code: "KeyF", metaKey: true }, input);
      press({ key: "k", code: "KeyK", metaKey: true }, input);
      expect(ctx.actions.focusFind).toHaveBeenCalledTimes(1);
      expect(ctx.actions.openPalette).toHaveBeenCalledTimes(1);
    });

    it("does not navigate behind a modal dialog", () => {
      const ctx = setup(MAC_DESKTOP);
      const dialog = document.body.appendChild(document.createElement("div"));
      dialog.setAttribute("role", "dialog");
      const button = dialog.appendChild(document.createElement("button"));
      press({ key: "[", code: "BracketLeft", metaKey: true }, button);
      press({ key: "f", code: "KeyF", metaKey: true }, button);
      expect(ctx.actions.goBack).not.toHaveBeenCalled();
      expect(ctx.actions.focusFind).not.toHaveBeenCalled();
    });
  });

  describe("single execution", () => {
    it("runs once when two listeners are installed", () => {
      const ctx = makeContext();
      setup(MAC_DESKTOP, ctx);
      setup(MAC_DESKTOP, ctx);
      press({ key: "k", code: "KeyK", metaKey: true });
      expect(ctx.actions.openPalette).toHaveBeenCalledTimes(1);
    });

    it("leaves a key another handler already took", () => {
      const ctx = setup(MAC_DESKTOP);
      const event = new KeyboardEvent("keydown", { key: "k", code: "KeyK", metaKey: true, cancelable: true });
      event.preventDefault();
      window.dispatchEvent(event);
      expect(ctx.actions.openPalette).not.toHaveBeenCalled();
    });

    it("skips a command whose shortcut the native menu owns", () => {
      const ctx = setup(MAC_DESKTOP, makeContext(), new Set<CommandId>(["go.back"]));
      const event = press({ key: "[", code: "BracketLeft", metaKey: true });
      expect(ctx.actions.goBack).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      press({ key: "]", code: "BracketRight", metaKey: true });
      expect(ctx.actions.goForward).toHaveBeenCalledTimes(1);
    });
  });
});
