/**
 * storybook-annotakit — shared hotkey kernel (v0.6.10, S6-D3c).
 *
 * ONE parser/matcher/guard used by BOTH bundles (preview layer + manager
 * bridge). Forked hotkey parsers drift — this repo's recurring bug class.
 *
 * v0.6.10 (S6-D3): default letters MOVED off SB 9/10's alt-based defaults
 * (SB 10.6 `defaultShortcuts`: fullScreen alt+F, panelPosition alt+D,
 * remount alt+R — verified live; SB 9.0 introduced the alt family, SB 8 is
 * out of support): freeze ⌥F→⌥I (ice), region ⌥R→⌥B (box), drawer ⌥D→⌥P
 * (panel). pin ⌥C / layer ⌥L / help ? are collision-free and keep their
 * letters. Explicit `hotkeys` configs are untouched — only defaults changed.
 * v0.6.11 (S7-B): the `drawer` key's ACTION is now "toggle the SB threads
 * panel" (the floating drawer is deleted) — the KEY keeps its name so
 * existing parameters.annotakit.hotkeys configs keep working.
 */

export interface HotkeySpec {
  key: string;
  alt: boolean;
}

export interface Hotkeys {
  pin: string;
  region: string;
  layer: string;
  /** v0.6.11 (S7-B): toggles the SB bottom panel (Annotakit selected) —
   *  key name kept from the drawer era for config compatibility. */
  drawer: string;
  help: string;
  /** v0.6.9 (S3): freeze/thaw the current view. */
  freeze: string;
}

/** v0.6.10 (S6-D3): alt-family defaults, off SB 9/10's collision set
 * (F/D/R/S/T/A/V/O/±/0/= + shift-combos E/I/L — all SB's). ⌥I = ice,
 * ⌥B = box, ⌥P = panel. */
export const DEFAULT_HOTKEYS: Hotkeys = { pin: 'alt+c', region: 'alt+b', layer: 'alt+l', drawer: 'alt+p', help: '?', freeze: 'alt+i' };

/** v0.5 semantic-shift warning, once per unique legacy spec (issue #18
 * suggestion 1): a 0.4-era plain-key config like `pin: 'c'` still works —
 * but only with ⌥/Alt held (the legacy compatibility path requires altKey),
 * a silent meaning change that cost adopters a key-by-key audit. */
const warnedLegacyKeys = new Set<string>();
function warnLegacyHotkey(userSpec: string | undefined, raw: string, withAlt: boolean): void {
  if (!userSpec || withAlt) return; // only user-provided plain-key specs
  if (raw === '?') return; // the help key is legitimately a plain key
  // v0.6.13 (audit 44-c P3-2): a whitespace-only spec strips to '' — it is
  // DEGENERATE, not a plain key, and this warning's "set it to alt+<raw>"
  // advice was self-referential garbage ("set … to 'alt+'"). The
  // substitution note in parseHotkey covers it.
  if (!raw) return;
  if (warnedLegacyKeys.has(raw)) return;
  warnedLegacyKeys.add(raw);
  console.info(
    `[storybook-annotakit] hotkey "${userSpec}" is a plain-key spec: since v0.5 plain keys collide with story interactions, so it fires with ⌥/Alt held — "${raw}" now means ⌥${raw.toUpperCase()}. Set parameters.annotakit.hotkeys to "alt+${raw}" to make the intent explicit (this fires on the physical key via e.code, so macOS Option composition is fine).`,
  );
}

/** v0.6.13 (audit 44-c P3-2): a degenerate spec ('alt+', bare 'alt',
 *  whitespace-only) silently ACTIVATES the default chord — the substitution
 *  used to be invisible while hotkeyLabel showed a nonexistent bare '⌥'.
 *  One honest console.info per unique spec (the warnLegacyHotkey shape). */
const warnedDegenerateKeys = new Set<string>();
function noteDegenerateHotkey(userSpec: string | undefined, raw: string, fbKey: string, fbAlt: boolean): void {
  if (!userSpec) return; // the default map itself being degenerate is a config bug, not an operator's
  if (warnedDegenerateKeys.has(raw)) return;
  warnedDegenerateKeys.add(raw);
  const chord = `${fbAlt ? '⌥' : ''}${fbKey.length === 1 ? fbKey.toUpperCase() : fbKey}`;
  console.info(
    `[storybook-annotakit] hotkey "${userSpec}" is degenerate (no key after the alt prefix / nothing but whitespace) — it now binds the DEFAULT ${chord}. Set parameters.annotakit.hotkeys to a full spec like "${fbAlt ? 'alt+' : ''}${fbKey}" to make the binding explicit.`,
  );
}

export function parseHotkey(spec: string | undefined, fallback: string): HotkeySpec {
  // v0.6.13 (S9/U2, 33-f P3): ALL whitespace is stripped BEFORE parsing —
  // the natural 'alt + c' spelling used to leave key '+ c' (a silently-dead
  // spec that never matched anything; probe-reproduced). hotkeyLabel strips
  // the same way so a WORKING ⌥C spec can never display as '⌥+ C'.
  const raw = (spec || fallback).trim().toLowerCase().replace(/\s+/g, '');
  // NOTE: the '+' MUST be part of the prefix match (optionally consumed) —
  // alternation like `alt|alt\+` lets bare `alt` win and leaves key='+c'
  // (live-browser-verified bug: default 'alt+c' never matched KeyC).
  const altPrefix = /^(?:alt|option|opt|⌥)\+?/;
  const withAlt = altPrefix.test(raw);
  warnLegacyHotkey(spec, raw, withAlt);
  const key = raw.replace(altPrefix, '');
  // v0.6.13 (S9/U2, 33-f P3): 'alt+' (or bare 'alt') — no key after the
  // prefix. The old `key || fallback` returned the fallback string VERBATIM
  // as the key ('alt+c' as a key — unmatchable, no warning). Parse the
  // FALLBACK's own key/alt shape instead; a degenerate fallback ('alt+' on
  // both sides) falls through to the verbatim terminal — dead but honest.
  if (!key) {
    const fbRaw = (fallback || '').trim().toLowerCase().replace(/\s+/g, '');
    const fbAlt = altPrefix.test(fbRaw);
    const fbKey = fbRaw.replace(altPrefix, '');
    if (fbKey) {
      const fbCollidable = !fbAlt && /^[a-z0-9]$/.test(fbKey);
      // v0.6.13 (audit 44-c P3-2): the substitution is no longer SILENT — a
      // spec that used to mean "dead" now activates the default chord; say
      // so once (the label side is hotkeyLabel's fallback param).
      noteDegenerateHotkey(spec, raw, fbKey, fbAlt || fbCollidable);
      return { key: fbKey, alt: fbAlt || fbCollidable };
    }
  }
  // v0.6.7 (audit P1): a collidable plain key (letter/digit — NOT the '?'
  // help key, NOT alt-prefixed defaults) requires Alt for real — the legacy
  // remap the warning promises. The explicit `alt+<key>` spelling remains
  // the no-surprise form.
  const collidablePlainKey = !withAlt && /^[a-z0-9]$/.test(key);
  return { key: key || fallback, alt: withAlt || collidablePlainKey };
}

export function isLetterSpecKey(key: string): boolean {
  return key.length === 1 && key >= 'a' && key <= 'z';
}

export function hotkeyMatches(e: KeyboardEvent, spec: HotkeySpec): boolean {
  // PHYSICAL-key matching (e.code): on macOS, Option+letter COMPOSES a
  // character (alt+c → "ç"), so e.key never equals the letter — e.code stays
  // "KeyC". Non-letters ('?') still match by e.key.
  const codeKey = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : null;
  const isLetterSpec = isLetterSpecKey(spec.key);
  const keyOk = isLetterSpec ? codeKey === spec.key : e.key.toLowerCase() === spec.key;
  if (!keyOk) return false;
  if (e.metaKey) return false; // never hijack ⌘ browser shortcuts
  // v0.6.13 (S9/U2, 33-f P3 as NARROWED by 34-c R5): AltGr IS a legitimate
  // Alt on Windows/Linux European layouts (de/fr/pl/…) — it reports as
  // ctrlKey+altKey, so the blanket ctrl guard used to kill every ⌥-hotkey
  // pressed with the RIGHT Alt key there (left-Alt only, undocumented).
  // getModifierState('AltGraph') is the ONLY honest exception: the blanket
  // ctrlKey+altKey wording would also admit the live Ctrl+Alt+letter
  // OS-shortcut family and regress the test-pinned never-hijack-⌘/Ctrl
  // guard. Meta is never part of the composition — guarded above, untouched.
  if (e.ctrlKey && e.getModifierState?.('AltGraph') !== true) return false;
  // v0.6.10 (S6-D3b): alt+shift+<letter> belongs to SB (openInIsolation
  // ⌥⇧I, copyStoryLink ⌥⇧L, openInEditor ⌥⇧E) — our letter specs never match
  // with Shift held (the pre-v0.6.10 matcher let ⌥⇧L double-fire SB's
  // copyStoryLink as our layer toggle). '?' (Shift+/ on US layouts) is a
  // non-letter spec and keeps working. The shift guard also stays for
  // AltGr+Shift (34-c R5: "keep the shift guard").
  if (e.shiftKey && isLetterSpec) return false;
  return e.altKey === spec.alt;
}

/** Legacy plain-key configs still respond to alt+same-key (e.code match —
 * macOS Option composes characters, e.key would be "ç"). */
export function altMatches(e: KeyboardEvent, spec: HotkeySpec): boolean {
  if (hotkeyMatches(e, spec)) return true;
  const codeKey = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : null;
  if (e.shiftKey) return false; // same shift rule as hotkeyMatches
  return !!e.altKey && !spec.alt && codeKey === spec.key;
}

/** True when the event target is a text-entry surface — hotkeys must never
 * fire from inside one (preview AND manager bridge share this guard). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT' ||
    t.isContentEditable
  );
}

/** Human form for UI strings: 'alt+i' → '⌥I'. Tolerates null/undefined specs
 *  (audit C-P3-6: a TS-legal `hotkeys: { pin: undefined }` hole must not
 *  crash the manager's title rendering). v0.6.13 (S9/U2): strips whitespace
 *  exactly like parseHotkey — a spec parseHotkey ACCEPTS as ⌥C must never
 *  label as '⌥+ C'. v0.6.13 (audit 44-c P3-2): a DEGENERATE spec ('alt+',
 *  bare 'alt', whitespace-only) used to label as a bare '⌥' — a chord that
 *  does not exist (parseHotkey substitutes the FALLBACK's key at bind time).
 *  With the optional `fallback` (the action's default), the label shows the
 *  REAL binding — the substituted key; without one it returns '' (never a
 *  phantom modifier). */
export function hotkeyLabel(spec: string | undefined | null, fallback?: string): string {
  const raw = (spec ?? '').trim().toLowerCase().replace(/\s+/g, '');
  // v0.6.14 (usability row 16, track 53-b): a whitespace-only spec used to
  // early-return '' WITHOUT consulting the fallback — but an EMPTY spec means
  // "not configured", the DEFAULT binding applies, and the label must show
  // it (the same substitution rule as the 'alt+' degenerate form below; the
  // manager's empty state rendered a missing chord gap "or  to drag").
  const fallbackChord = (): string => {
    if (!fallback) return '';
    const fbRaw = fallback.trim().toLowerCase().replace(/\s+/g, '');
    const altPrefix = /^(?:alt|option|opt|⌥)\+?/;
    const fbAlt = altPrefix.test(fbRaw);
    const fbKey = fbRaw.replace(altPrefix, '');
    if (!fbKey) return '';
    const shown = fbKey.length === 1 ? fbKey.toUpperCase() : fbKey;
    return fbAlt ? `⌥${shown}` : shown;
  };
  if (!raw) return fallbackChord(); // empty/whitespace spec: the default binds
  const altPrefix = /^(?:alt|option|opt|⌥)\+?/;
  const withAlt = altPrefix.test(raw);
  const key = raw.replace(altPrefix, '');
  if (!key) {
    const fb = fallbackChord();
    if (fb) return fb;
    return ''; // degenerate with no (usable) fallback: no phantom modifier
  }
  const shown = key.length === 1 ? key.toUpperCase() : key;
  return withAlt ? `⌥${shown}` : shown;
}
