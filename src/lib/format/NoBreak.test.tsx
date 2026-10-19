/**
 * Compact numbers with a magnitude suffix (`1.8万`, `39.8M`) are one atom:
 * the numeral and its suffix never split across lines, however narrow the
 * container (plan §4.4, F3b review finding 5).
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { NoBreak } from "./NoBreak";

describe("NoBreak", () => {
  it("renders its text in a span that never wraps", () => {
    const { container } = render(<NoBreak>1.8万</NoBreak>);
    const span = container.firstElementChild;
    expect(span?.tagName).toBe("SPAN");
    expect(span?.style.whiteSpace).toBe("nowrap");
    expect(span?.textContent).toBe("1.8万");
  });

  it("keeps extra classes and styles", () => {
    const { container } = render(
      <NoBreak className="font-mono" style={{ color: "red" }}>
        50.1万
      </NoBreak>,
    );
    const span = container.firstElementChild as HTMLElement;
    expect(span.className).toContain("font-mono");
    expect(span.style.color).toBe("red");
    expect(span.style.whiteSpace).toBe("nowrap");
  });
});
