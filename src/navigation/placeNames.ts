/**
 * Place names: one name per place (plan F4a, D17; audit G-MC2, V-GS1).
 *
 * Every surface that names a place reads its key from here: the sidebar
 * Library rows and rail, the header's view tabs, the content title and tab
 * titles (`VIEW_REGISTRY`), the palette's "Open …" commands and the phone tab
 * bar. A place reached at another scope keeps the same noun with the scope
 * after it ("Analytics" / "Analytics · All projects") instead of a second
 * name ("Global Statistics" vs "Global Overview").
 *
 * The names stay short enough for the phone tab bar (five tabs at 390 px).
 */
import type { View } from "./place";

/**
 * Views that have no table name yet, and why. Every view is either here or in
 * `PLACE_NAMES` (`placeNames.invariant.test.tsx`).
 */
export const UNNAMED_VIEWS = {
  empty: "Not a place: the start screen asks the user to pick a session.",
  settingsManager:
    "\"Claude Code settings\" (title, palette) vs \"Settings\" (phone tab): the full name does not fit the phone tab bar, so it waits for the phone tab layout (MB1).",
} as const satisfies Partial<Record<View, string>>;

type NamedView = Exclude<View, keyof typeof UNNAMED_VIEWS>;

export const PLACE_NAMES = {
  conversation: "common.place.messages",
  analytics: "common.place.analytics",
  globalStats: "common.place.analyticsAllProjects",
  edits: "common.place.edits",
  board: "common.place.board",
  archive: "common.place.archive",
} as const satisfies Record<NamedView, string>;

export type PlaceNameKey = (typeof PLACE_NAMES)[NamedView];

/** The i18n key of a place's one name. */
export const placeNameKey = <V extends NamedView>(view: V): (typeof PLACE_NAMES)[V] => PLACE_NAMES[view];
