import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

/**
 * Button state contract (inner-UI plan F2a, G-ST1 · ST4 · ST5 · ST6).
 *
 * - Focus: the base layer's one ring (`:focus-visible`, --focus-ring);
 *   no variant switches it off.
 * - Hover is one step, pressed one more, and nothing moves or scales. A
 *   filled variant steps its fill towards the surface behind it (`/85`,
 *   `/70`; destructive `/88`, `/76` so its label keeps 4.5:1); the light
 *   and transparent ones lay the text colour over the surface (ghost and
 *   outline 14% then 28%, secondary 20% then 34%) and show their label in
 *   full --fg. Every step is big enough to see and keeps the label
 *   readable in all four themes (src/test/primitiveStates.contrast.test.tsx).
 * - Disabled is one look per variant from the disabled tokens (--fg-disabled
 *   on --muted), not 50% opacity. Button marks it `data-disabled` for
 *   `disabled` and for `aria-disabled="true"`, so both look the same; an
 *   aria-disabled button stays in the tab order and ignores click, Enter
 *   and Space (and does not open a menu it triggers). With `asChild` the
 *   child's own handlers are held back too.
 * - `loading`: `aria-busy` + `aria-disabled`, clicks ignored, focus kept
 *   (a natively disabled button would drop it). The label stays in the
 *   layout, invisible and still the accessible name, under the shared
 *   Spinner; it lays its parts out with the button's own direction, gap
 *   and alignment, so the size does not change whatever the caller sets.
 *   The variant's look stays.
 *
 * `accent`, `success` and `warning` have no call sites; they keep their
 * names (F2b renames and removes variants) and render `default`.
 */
const FILLED = "bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/70";
const FILLED_DISABLED = "data-disabled:bg-muted data-disabled:text-fg-disabled";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-body font-medium transition-colors",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    "data-disabled:cursor-not-allowed forced-colors:data-disabled:text-[color:GrayText] data-loading:cursor-progress",
  ].join(" "),
  {
    variants: {
      variant: {
        default: `${FILLED} ${FILLED_DISABLED}`,
        destructive: `bg-destructive text-destructive-foreground hover:bg-destructive/88 active:bg-destructive/76 ${FILLED_DISABLED}`,
        outline:
          "border border-input bg-background hover:bg-foreground/14 hover:text-foreground active:bg-foreground/28 data-disabled:bg-background data-disabled:text-fg-disabled",
        secondary: `bg-secondary text-secondary-foreground hover:bg-foreground/20 hover:text-foreground active:bg-foreground/34 ${FILLED_DISABLED}`,
        ghost:
          "hover:bg-foreground/14 hover:text-foreground active:bg-foreground/28 data-disabled:bg-transparent data-disabled:text-fg-disabled",
        link: "text-primary underline-offset-4 hover:underline active:decoration-2 data-disabled:text-fg-disabled data-disabled:no-underline",
        /** @deprecated No call sites; renders `default` until F2b removes it. */
        accent: `${FILLED} ${FILLED_DISABLED}`,
        /** @deprecated No call sites; renders `default` until F2b removes it. */
        success: `${FILLED} ${FILLED_DISABLED}`,
        /** @deprecated No call sites; renders `default` until F2b removes it. */
        warning: `${FILLED} ${FILLED_DISABLED}`,
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-list",
        lg: "h-12 rounded-lg px-6 text-title",
        icon: "h-10 w-10",
        "icon-sm": "h-8 w-8",
        "icon-lg": "h-12 w-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * Busy: `aria-busy` and `aria-disabled`, clicks ignored, focus kept; the
   * label keeps its width under the shared Spinner. Ignored with `asChild`.
   */
  loading?: boolean;
}

/** Keys that activate a button or open the menu it triggers. */
const ACTIVATION_KEYS = new Set(["Enter", " ", "ArrowDown", "ArrowUp"]);

/** An inactive button's key handler: the activation keys reach no handler, other keys do. */
const withoutActivationKeys =
  <T extends Element>(handler?: React.KeyboardEventHandler<T>): React.KeyboardEventHandler<T> =>
  (event) => {
    if (!ACTIVATION_KEYS.has(event.key)) handler?.(event);
  };

/**
 * An inactive button's click, in the capture phase: it runs before every
 * click handler of the button (Slot runs an `asChild` child's own before
 * Button's) and stops them, the form submit and the link.
 */
const ignoreClick = (event: React.MouseEvent<HTMLElement>) => {
  event.preventDefault();
  event.stopPropagation();
};

/** The handlers of an `asChild` child that an inactive Button holds back. */
type ChildHandlers = Pick<React.DOMAttributes<Element>, "onClickCapture" | "onPointerDown" | "onPointerDownCapture" | "onKeyDown">;

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, onClick, onClickCapture, onPointerDown, onPointerDownCapture, onKeyDown, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const busy = loading && !asChild;
    const ariaDisabled = props["aria-disabled"] === true || props["aria-disabled"] === "true";
    // Focusable but inactive: aria-disabled or busy.
    const inert = ariaDisabled || busy;
    // Slot runs the child's own handlers before Button's: an inactive Button
    // holds back the child's pointer down and activation keys as it holds
    // back its own (its clicks stop at ignoreClick).
    const content =
      inert && asChild && React.isValidElement<ChildHandlers>(children)
        ? React.cloneElement(children, {
            onClickCapture: undefined,
            onPointerDown: undefined,
            onPointerDownCapture: undefined,
            onKeyDown: withoutActivationKeys(children.props.onKeyDown),
          })
        : children;
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), busy && "relative", className)}
        disabled={disabled}
        {...props}
        aria-disabled={inert ? true : props["aria-disabled"]}
        aria-busy={busy ? true : props["aria-busy"]}
        data-disabled={(disabled || ariaDisabled) && !busy ? "" : undefined}
        data-loading={busy ? "" : undefined}
        onClickCapture={inert ? ignoreClick : onClickCapture}
        onClick={inert ? undefined : onClick}
        onPointerDown={inert ? undefined : onPointerDown}
        onPointerDownCapture={inert ? undefined : onPointerDownCapture}
        onKeyDown={inert ? withoutActivationKeys(onKeyDown) : onKeyDown}
      >
        {busy ? (
          <>
            {/* Inherits the button's flex direction, wrap, gap and alignment: as wide and tall as the parts without it. */}
            <span
              data-slot="button-label"
              className="inline-flex opacity-0 [flex-flow:inherit] [gap:inherit] [place-content:inherit] [place-items:inherit]"
            >
              {children}
            </span>
            <span className="absolute inset-0 flex items-center justify-center">
              <Spinner decorative />
            </span>
          </>
        ) : (
          content
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
