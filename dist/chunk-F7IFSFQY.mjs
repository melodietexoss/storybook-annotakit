// src/shared/hotkeys.ts
var DEFAULT_HOTKEYS = { pin: "alt+c", region: "alt+b", layer: "alt+l", drawer: "alt+p", help: "?", freeze: "alt+i" };
var warnedLegacyKeys = /* @__PURE__ */ new Set();
function warnLegacyHotkey(userSpec, raw, withAlt) {
  if (!userSpec || withAlt) return;
  if (raw === "?") return;
  if (warnedLegacyKeys.has(raw)) return;
  warnedLegacyKeys.add(raw);
  console.info(
    `[storybook-annotakit] hotkey "${userSpec}" is a plain-key spec: since v0.5 plain keys collide with story interactions, so it fires with \u2325/Alt held \u2014 "${raw}" now means \u2325${raw.toUpperCase()}. Set parameters.annotakit.hotkeys to "alt+${raw}" to make the intent explicit (this fires on the physical key via e.code, so macOS Option composition is fine).`
  );
}
function parseHotkey(spec, fallback) {
  const raw = (spec || fallback).trim().toLowerCase();
  const altPrefix = /^(?:alt|option|opt|⌥)\+?\s*/;
  const withAlt = altPrefix.test(raw);
  warnLegacyHotkey(spec, raw, withAlt);
  const key = raw.replace(altPrefix, "");
  const collidablePlainKey = !withAlt && /^[a-z0-9]$/.test(key);
  return { key: key || fallback, alt: withAlt || collidablePlainKey };
}
function isLetterSpecKey(key) {
  return key.length === 1 && key >= "a" && key <= "z";
}
function hotkeyMatches(e, spec) {
  const codeKey = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : null;
  const isLetterSpec = isLetterSpecKey(spec.key);
  const keyOk = isLetterSpec ? codeKey === spec.key : e.key.toLowerCase() === spec.key;
  if (!keyOk) return false;
  if (e.ctrlKey || e.metaKey) return false;
  if (e.shiftKey && isLetterSpec) return false;
  return e.altKey === spec.alt;
}
function altMatches(e, spec) {
  if (hotkeyMatches(e, spec)) return true;
  const codeKey = e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : null;
  if (e.shiftKey) return false;
  return !!e.altKey && !spec.alt && codeKey === spec.key;
}
function isTypingTarget(t) {
  if (!(t instanceof HTMLElement)) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}
function hotkeyLabel(spec) {
  const raw = (spec ?? "").trim().toLowerCase();
  if (!raw) return "";
  const altPrefix = /^(?:alt|option|opt|⌥)\+?\s*/;
  const withAlt = altPrefix.test(raw);
  const key = raw.replace(altPrefix, "");
  const shown = key.length === 1 ? key.toUpperCase() : key;
  return withAlt ? `\u2325${shown}` : shown;
}

export {
  DEFAULT_HOTKEYS,
  parseHotkey,
  isLetterSpecKey,
  hotkeyMatches,
  altMatches,
  isTypingTarget,
  hotkeyLabel
};
