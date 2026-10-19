/**
 * Keep numbers whole inside Korean text (inner-UI plan F1b, CJK line breaking).
 *
 * The Korean UI breaks text between words (`word-break: keep-all`, base layer
 * in src/index.css). WebKit implements keep-all for a text node that holds any
 * non-Latin-1 character as "break at spaces and after every punctuation mark"
 * (WebKit 311090@main, bug 312099), digits or not. So a date and time rendered
 * as one text node, "2026년 6월 19일 오후 01:26:25", can wrap as "… 오후 01:" /
 * "26:25", and "총 1,234개" as "총 1," / "234개". CSS cannot reach this: the
 * break comes from the text node's contents. A text node of Latin-1 characters
 * only gets keep-all's space breaks, so a number in its own text node stays
 * whole, and no break is added where the parts meet.
 *
 * `keepNumbersWhole(text)` returns `text` split so that every number with
 * inner punctuation (01:26:25, 1,234, 17.6K, 3.5%) is its own string. Used as
 * JSX children, each string renders as its own text node; the visible text and
 * its copy are unchanged. Text without such a number comes back as is.
 */

// A number with at least one inner separator (: , . /), an optional ASCII
// sign, and a compact magnitude or percent sign that belongs to it. A Unicode
// minus (U+2212) stays outside the match: it is not Latin-1, so in the
// number's node it would bring the punctuation breaks back ("−1," / "200").
const PUNCTUATED_NUMBER = /[+-]?\d+(?:[.,:/]\d+)+[KMBT%]?/g;

export function keepNumbersWhole(text: string): string | string[] {
  const parts: string[] = [];
  let last = 0;
  for (const match of text.matchAll(PUNCTUATED_NUMBER)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(match[0]);
    last = start + match[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
