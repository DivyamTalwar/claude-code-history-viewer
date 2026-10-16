/**
 * How the ⌘K palette finds and names commands.
 */
import type { CommandId } from "./manifest";
import { isCommandEnabled, paletteCommands, type AppCommand, type CommandContext } from "./registry";

/** cmdk item value of a command; message results use another prefix. */
export const commandItemValue = (id: CommandId): string => `command:${id}`;

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/**
 * Whether `query` picks this title: every word of the query starts a word of
 * the title (or of the id), so "set" finds "Open Settings Manager" but a
 * message search for "et" does not drag in every title containing "et".
 * Japanese and Chinese titles have no spaces, so a CJK word matches anywhere
 * in the title.
 */
export function matchesCommandQuery(query: string, title: string, id: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${title} ${id.replace(/[.]/g, " ")}`
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase()
    .split(/[\s/…]+/)
    .filter(Boolean);
  const lowerTitle = title.toLocaleLowerCase();
  return words.every((word) =>
    CJK.test(word) ? lowerTitle.includes(word) : haystack.some((candidate) => candidate.startsWith(word)),
  );
}

export interface PaletteEntry {
  command: AppCommand;
  title: string;
  enabled: boolean;
}

/** The commands the palette shows for `query`, in manifest order. */
export function paletteEntries(
  query: string,
  ctx: CommandContext,
  translate: (key: string) => string,
): PaletteEntry[] {
  return paletteCommands(ctx)
    .map((command) => ({ command, title: translate(command.labelKey), enabled: isCommandEnabled(command, ctx) }))
    .filter(({ command, title }) => matchesCommandQuery(query, title, command.id));
}
