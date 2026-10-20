/**
 * Button state contract (inner-UI plan F2a, G-ST1 · ST4 · ST5 · ST6).
 *
 * - Every variant and size keeps its name (renames are F2b's).
 * - Keyboard focus is the base ring: no variant opts out (`outline-none`).
 * - Hover is one step, pressed one more, and nothing changes size (no
 *   `scale-*`). How far each step moves and that labels stay readable on it
 *   is computed per theme in `src/test/primitiveStates.contrast.test.ts`;
 *   that the steps show on screen is `pnpm ui:states`.
 * - `aria-disabled="true"` looks exactly like `disabled` but stays in the
 *   tab order, and click, Enter and Space do nothing.
 * - `loading` is busy (`aria-busy`) and unavailable (`aria-disabled`), keeps
 *   its name and its width (the label stays in the layout, invisible, under
 *   the shared Spinner) and keeps focus. jsdom cannot measure, so the width
 *   is measured in real WebKit by scripts/ui-capture/test/primitives.states.test.mjs.
 */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button, buttonVariants } from "./button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

afterEach(cleanup);

const VARIANTS = ["default", "destructive", "outline", "secondary", "ghost", "link", "accent", "success", "warning"] as const;
const SIZES = ["default", "sm", "lg", "icon", "icon-sm", "icon-lg"] as const;

const classesOf = (variant: (typeof VARIANTS)[number], size: (typeof SIZES)[number] = "default") =>
  buttonVariants({ variant, size }).split(/\s+/).filter(Boolean);

describe("Button variants and sizes", () => {
  it("keeps every variant and size name", () => {
    for (const variant of VARIANTS) {
      for (const size of SIZES) expect(classesOf(variant, size).length, `${variant}/${size}`).toBeGreaterThan(0);
    }
  });

  it("never switches the focus ring off and never scales", () => {
    for (const variant of VARIANTS) {
      for (const size of SIZES) {
        const classes = classesOf(variant, size);
        expect(classes.filter((c) => /(^|:)outline-(none|hidden)$/.test(c)), `${variant}/${size}`).toEqual([]);
        expect(classes.filter((c) => /(^|:)-?scale-/.test(c)), `${variant}/${size}`).toEqual([]);
      }
    }
  });

  it("gives every variant a hover step and a pressed step", () => {
    for (const variant of VARIANTS) {
      const classes = classesOf(variant);
      expect(classes.some((c) => c.startsWith("hover:")), `${variant} hover`).toBe(true);
      expect(classes.some((c) => c.startsWith("active:")), `${variant} pressed`).toBe(true);
    }
  });

  it("casts no shadow (a button sits in the flow)", () => {
    for (const variant of VARIANTS) expect(classesOf(variant).filter((c) => /(^|:)shadow(-|$)/.test(c)), variant).toEqual([]);
  });
});

describe("aria-disabled", () => {
  it("looks exactly like disabled", () => {
    render(
      <>
        {VARIANTS.map((variant) => (
          <div key={variant}>
            <Button variant={variant} disabled>
              {`${variant} native`}
            </Button>
            <Button variant={variant} aria-disabled="true">
              {`${variant} aria`}
            </Button>
          </div>
        ))}
      </>,
    );
    for (const variant of VARIANTS) {
      const native = screen.getByRole("button", { name: `${variant} native` });
      const aria = screen.getByRole("button", { name: `${variant} aria` });
      expect(native).toHaveAttribute("data-disabled");
      expect(aria).toHaveAttribute("data-disabled");
      expect(aria.className, variant).toBe(native.className);
    }
  });

  it("stays in the tab order and keeps focus", () => {
    render(<Button aria-disabled="true">Restore</Button>);
    const button = screen.getByRole("button", { name: "Restore" });
    expect(button).not.toBeDisabled();
    expect(button.tabIndex).toBe(0);
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
  });

  it("ignores click, pointer down, Enter and Space, and does not submit its form", () => {
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    const onKeyDown = vi.fn();
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" aria-disabled onClick={onClick} onPointerDown={onPointerDown} onKeyDown={onKeyDown}>
          Send
        </Button>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    expect(onClick).not.toHaveBeenCalled();
    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not open a menu it triggers (the same trigger without it does)", () => {
    const menu = (ariaDisabled: boolean) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button aria-disabled={ariaDisabled || undefined}>More</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    const { unmount } = render(menu(true));
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    expect(screen.queryByRole("menu")).toBeNull();
    unmount();

    render(menu(false));
    fireEvent.keyDown(screen.getByRole("button", { name: "More" }), { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("an enabled button still handles everything", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button).not.toHaveAttribute("data-disabled");
    expect(button).not.toHaveAttribute("aria-disabled");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("loading", () => {
  it("is busy and unavailable, keeps its accessible name and stays enabled", () => {
    render(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("data-loading");
    // Busy is not the disabled look: the variant stays.
    expect(button).not.toHaveAttribute("data-disabled");
  });

  it("keeps the label in the layout, invisible, under the shared spinner", () => {
    render(
      <Button loading>
        <svg data-testid="glyph" />
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    const label = button.querySelector<HTMLElement>('[data-slot="button-label"]');
    expect(label, "label wrapper").not.toBeNull();
    expect(label!.textContent).toBe("Save");
    expect(label!.contains(screen.getByTestId("glyph"))).toBe(true);
    expect(label!.className.split(/\s+/)).toContain("opacity-0");
    // One spinner, the shared one, hidden from assistive tech (aria-busy says it).
    const spinners = button.querySelectorAll('[data-slot="spinner"]');
    expect(spinners).toHaveLength(1);
    expect(spinners[0]!.getAttribute("aria-hidden")).toBe("true");
    expect(button.querySelector('[role="status"]')).toBeNull();
  });

  it("renders no wrapper or spinner when idle", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.querySelector('[data-slot="button-label"]')).toBeNull();
    expect(button.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("ignores clicks while busy and keeps keyboard focus when it starts", () => {
    const save = vi.fn();
    function Saving() {
      const [busy, setBusy] = useState(false);
      return (
        <Button
          loading={busy}
          onClick={() => {
            save();
            setBusy(true);
          }}
        >
          Save
        </Button>
      );
    }
    render(<Saving />);
    const button = screen.getByRole("button", { name: "Save" });
    act(() => button.focus());
    fireEvent.click(button);
    expect(save).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-busy", "true");
    // Still the same, enabled element with focus: a natively disabled
    // button would drop focus to <body> in the browser.
    expect(document.activeElement).toBe(button);
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
