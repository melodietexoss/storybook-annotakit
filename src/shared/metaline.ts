/**
 * storybook-annotakit — shared metadata-line hardening (DD-10, S9).
 *
 * Every metadata value rendered into an agent-facing surface (the md
 * digest, the static panel export, the GitHub mirror title/body) is
 * ATTACKER-INFLUENCED: a story title, a component name, a captured prop,
 * a css selector, a thread id adopted verbatim from a create door. The
 * server hardened its digest (C22, H-B-09) with a local `metaLine`; the
 * client twins rendered the same fields raw — newlines in them injected
 * fake `### Thread N` headings and fake `- thread id:` stamps into
 * static-mode digests AND browser-published issue bodies (live-reproduced
 * by 33-f; the fake stamp is additionally the exact pattern
 * heal-mirrors.mjs keys re-push decisions on). This module is the ONE
 * source for both sides — imported by the server digest, the static
 * digest/export builders and both mirror engines; never hand-copied.
 *
 * The hardening, in order:
 *   1. single-line + collapse ALL whitespace runs (`\s+` → ` `) — a
 *      newline is the injection primitive;
 *   2. neutralize REPEATED leading heading/bullet markers (`###`, `-`,
 *      `*`, any mix) — a value must never mint a markdown heading or a
 *      digest/mirror line that other tooling parses;
 *   3. cap with an honest ellipsis (default 300; element/selector use 400
 *      — the server digest's budgets, kept identical).
 */

export function metaLine(value: string, cap = 300): string {
  let line = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  // repeated leading markers — `## - ### text` strips to `text`, not `- ### text`
  line = line.replace(/^(?:(?:#+|[-*]+)\s*)+/, '');
  return line.length > cap ? line.slice(0, cap) + '…' : line;
}
