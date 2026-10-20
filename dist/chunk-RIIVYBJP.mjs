// src/shared/hotkeys.ts
var DEFAULT_HOTKEYS = { pin: "alt+c", region: "alt+b", layer: "alt+l", drawer: "alt+p", help: "?", freeze: "alt+i" };
var warnedLegacyKeys = /* @__PURE__ */ new Set();
function warnLegacyHotkey(userSpec, raw, withAlt) {
  if (!userSpec || withAlt) return;
  if (raw === "?") return;
  if (!raw) return;
  if (warnedLegacyKeys.has(raw)) return;
  warnedLegacyKeys.add(raw);
  console.info(
    `[storybook-annotakit] hotkey "${userSpec}" is a plain-key spec: since v0.5 plain keys collide with story interactions, so it fires with \u2325/Alt held \u2014 "${raw}" now means \u2325${raw.toUpperCase()}. Set parameters.annotakit.hotkeys to "alt+${raw}" to make the intent explicit (this fires on the physical key via e.code, so macOS Option composition is fine).`
  );
}
var warnedDegenerateKeys = /* @__PURE__ */ new Set();
function noteDegenerateHotkey(userSpec, raw, fbKey, fbAlt) {
  if (!userSpec) return;
  if (warnedDegenerateKeys.has(raw)) return;
  warnedDegenerateKeys.add(raw);
  const chord = `${fbAlt ? "\u2325" : ""}${fbKey.length === 1 ? fbKey.toUpperCase() : fbKey}`;
  console.info(
    `[storybook-annotakit] hotkey "${userSpec}" is degenerate (no key after the alt prefix / nothing but whitespace) \u2014 it now binds the DEFAULT ${chord}. Set parameters.annotakit.hotkeys to a full spec like "${fbAlt ? "alt+" : ""}${fbKey}" to make the binding explicit.`
  );
}
function parseHotkey(spec, fallback) {
  const raw = (spec || fallback).trim().toLowerCase().replace(/\s+/g, "");
  const altPrefix = /^(?:alt|option|opt|⌥)\+?/;
  const withAlt = altPrefix.test(raw);
  warnLegacyHotkey(spec, raw, withAlt);
  const key = raw.replace(altPrefix, "");
  if (!key) {
    const fbRaw = (fallback || "").trim().toLowerCase().replace(/\s+/g, "");
    const fbAlt = altPrefix.test(fbRaw);
    const fbKey = fbRaw.replace(altPrefix, "");
    if (fbKey) {
      const fbCollidable = !fbAlt && /^[a-z0-9]$/.test(fbKey);
      noteDegenerateHotkey(spec, raw, fbKey, fbAlt || fbCollidable);
      return { key: fbKey, alt: fbAlt || fbCollidable };
    }
  }
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
  if (e.metaKey) return false;
  if (e.ctrlKey && e.getModifierState?.("AltGraph") !== true) return false;
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
function hotkeyLabel(spec, fallback) {
  const raw = (spec ?? "").trim().toLowerCase().replace(/\s+/g, "");
  const fallbackChord = () => {
    if (!fallback) return "";
    const fbRaw = fallback.trim().toLowerCase().replace(/\s+/g, "");
    const altPrefix2 = /^(?:alt|option|opt|⌥)\+?/;
    const fbAlt = altPrefix2.test(fbRaw);
    const fbKey = fbRaw.replace(altPrefix2, "");
    if (!fbKey) return "";
    const shown2 = fbKey.length === 1 ? fbKey.toUpperCase() : fbKey;
    return fbAlt ? `\u2325${shown2}` : shown2;
  };
  if (!raw) return fallbackChord();
  const altPrefix = /^(?:alt|option|opt|⌥)\+?/;
  const withAlt = altPrefix.test(raw);
  const key = raw.replace(altPrefix, "");
  if (!key) {
    const fb = fallbackChord();
    if (fb) return fb;
    return "";
  }
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
