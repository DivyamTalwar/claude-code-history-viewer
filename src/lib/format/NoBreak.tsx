/**
 * A run of text that must stay on one line: a compact number and its
 * magnitude suffix (`1.8万`, `50.1万`, `1.8만`) are one atom, however narrow
 * the container (plan §4.4; CJK suffixes otherwise wrap onto a new line at
 * ~390px). Shared so every screen rendering a formatted number can use it.
 */
import type { CSSProperties, ReactNode } from "react";

export const NoBreak = ({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) => (
  <span className={className} style={{ whiteSpace: "nowrap", ...style }}>
    {children}
  </span>
);
