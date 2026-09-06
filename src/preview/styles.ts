/**
 * storybook-annotakit — overlay CSS (injected at runtime, fully scoped under
 * .annota-root / [data-annota-*] attributes; no dependence on the host
 * project's Tailwind or CSS setup).
 */

export const OVERLAY_CSS = `
.annota-root {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: #1f2430;
  --annota-accent: #4f46e5;
  --annota-danger: #dc2626;
  --annota-ok: #16a34a;
  --annota-warn: #d97706;
}
.annota-root * { box-sizing: border-box; }
.annota-root button, .annota-root textarea, .annota-root input {
  font: inherit;
  color: inherit;
}

/* ---------- pin markers ---------- */
.annota-pin {
  position: fixed;
  pointer-events: auto;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--annota-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
  border: 2px solid #fff;
  box-shadow: 0 1px 4px rgba(15, 23, 42, .35);
  user-select: none;
  transition: transform .1s ease;
}
.annota-pin:hover { transform: scale(1.15); }
.annota-pin.is-resolved { background: #94a3b8; }
.annota-pin.is-orphan { background: #fff; color: #94a3b8; border-style: dashed; }
.annota-pin.is-active { outline: 2px solid var(--annota-accent); outline-offset: 2px; }

/* ---------- region outlines ---------- */
.annota-region {
  position: fixed;
  pointer-events: auto;
  border: 2px dashed var(--annota-accent);
  background: rgba(79, 70, 229, .06);
  border-radius: 4px;
  cursor: pointer;
}
.annota-region.is-resolved { border-color: #94a3b8; background: rgba(148,163,184,.06); }
.annota-region .annota-region-tag {
  position: absolute;
  top: -20px;
  left: -2px;
  background: var(--annota-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 999px;
}
.annota-region.is-resolved .annota-region-tag { background: #94a3b8; }

/* ---------- capture mode ---------- */
.annota-capture-hint {
  position: fixed;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: #111827;
  color: #f9fafb;
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
  box-shadow: 0 4px 14px rgba(0,0,0,.3);
}
.annota-hover-box {
  position: fixed;
  border: 2px solid var(--annota-accent);
  background: rgba(79, 70, 229, .12);
  border-radius: 3px;
  pointer-events: none;
}
body.annota-cursor * { cursor: crosshair !important; }

/* drag region */
.annota-drag-rect {
  position: fixed;
  border: 2px solid var(--annota-accent);
  background: rgba(79, 70, 229, .12);
  pointer-events: none;
  border-radius: 3px;
}

/* ---------- cards (composer / popover / drawer / help) ---------- */
.annota-card {
  position: fixed;
  pointer-events: auto;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 40px rgba(15, 23, 42, .22), 0 2px 8px rgba(15, 23, 42, .1);
  border: 1px solid #e5e7eb;
  width: 340px;
  max-height: 60vh;
  overflow: auto;
}
.annota-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 12px;
  border-bottom: 1px solid #eef0f4;
  font-weight: 700;
  font-size: 12px;
}
.annota-card-header .annota-grow { flex: 1; }
.annota-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #334155;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.annota-chip.is-component { background: #eef2ff; border-color: #c7d2fe; color: #3730a3; }
.annota-chip.is-meta { background: #f8fafc; color: #64748b; }
.annota-chip.is-gh { background: #ecfdf5; border-color: #a7f3d0; color: #047857; text-decoration: none; cursor: pointer; }

.annota-meta-rows { padding: 8px 12px; border-bottom: 1px solid #eef0f4; }
.annota-meta-rows div {
  font-size: 11px;
  color: #64748b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.annota-meta-rows b { color: #334155; font-weight: 600; }

.annota-comment { padding: 8px 12px; border-bottom: 1px solid #f1f3f7; }
.annota-comment .annota-comment-head {
  font-size: 11px;
  color: #64748b;
  display: flex;
  gap: 6px;
  margin-bottom: 2px;
}
.annota-comment .annota-comment-head b { color: #1f2430; }
.annota-comment p { margin: 0; white-space: pre-wrap; }

.annota-reply-row { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid #eef0f4; }
.annota-input, .annota-textarea {
  width: 100%;
  border: 1px solid #d7dbe3;
  border-radius: 7px;
  padding: 6px 8px;
  background: #fff;
  outline: none;
}
.annota-textarea { min-height: 64px; resize: vertical; }
.annota-input:focus, .annota-textarea:focus { border-color: var(--annota-accent); }

.annota-btn {
  border: 1px solid #d7dbe3;
  background: #fff;
  border-radius: 7px;
  padding: 5px 11px;
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
  color: #334155;
  white-space: nowrap;
}
.annota-btn:hover { background: #f8fafc; }
.annota-btn.is-primary { background: var(--annota-accent); border-color: var(--annota-accent); color: #fff; }
.annota-btn.is-primary:hover { filter: brightness(1.08); }
.annota-btn.is-danger { color: var(--annota-danger); border-color: #fecaca; }
.annota-btn.is-ok { color: var(--annota-ok); border-color: #bbf7d0; }
.annota-btn.is-small { padding: 2px 8px; font-size: 11px; border-radius: 5px; }
.annota-btn:disabled { opacity: .5; cursor: default; }

.annota-status-banner {
  padding: 8px 12px;
  font-size: 11.5px;
  border-radius: 8px;
  margin: 8px 12px;
}
.annota-status-banner.is-error { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
.annota-status-banner.is-info { background: #f0f9ff; color: #075985; border: 1px solid #bae6fd; }

/* ---------- dev-only badge (passive notice, no interaction — the launcher
   is GONE; entry points are the native SB toolbar buttons + ⌥ hotkeys) ---------- */
.annota-badge {
  position: fixed;
  right: 18px;
  bottom: 18px;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 7px;
  background: rgba(255, 255, 255, .92);
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  padding: 7px 12px;
  font-weight: 700;
  font-size: 12px;
  color: #64748b;
  box-shadow: 0 4px 16px rgba(15, 23, 42, .12);
  user-select: none;
}

/* static-build provenance chip: same visual family, top-right so it never
   fights the pins/drawer at the bottom of the canvas. */
.annota-static-chip {
  position: fixed;
  right: 18px;
  top: 12px;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 251, 235, .95);
  border: 1px solid #fcd34d;
  border-radius: 999px;
  padding: 4px 10px;
  font-weight: 700;
  font-size: 11px;
  color: #92400e;
  box-shadow: 0 2px 10px rgba(15, 23, 42, .10);
  user-select: none;
}

/* rich one-line element identity (composer) — same string as the digest */
.annota-element-summary {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: #334155;
  word-break: break-all;
  white-space: pre-wrap;
}

/* ---------- drawer ---------- */
.annota-drawer {
  position: fixed;
  right: 18px;
  /* v0.5.0: no more in-canvas launcher below it — dock to the corner */
  bottom: 18px;
  width: 340px;
  max-height: 65vh;
  overflow: auto;
}
.annota-thread-row { padding: 10px 12px; border-bottom: 1px solid #f1f3f7; cursor: pointer; }
.annota-thread-row:hover { background: #f8fafc; }
.annota-thread-row.is-active { background: #eef2ff; }
.annota-thread-row .annota-thread-title { font-weight: 600; font-size: 12.5px; }
.annota-thread-row .annota-thread-sub { font-size: 11px; color: #64748b; margin-top: 2px; }
.annota-thread-row.is-resolved .annota-thread-title { text-decoration: line-through; color: #94a3b8; }
.annota-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--annota-warn);
  margin-right: 5px;
}
.annota-dot.is-resolved { background: var(--annota-ok); }
.annota-dot.is-orphan { background: #cbd5e1; }

/* ---------- help ---------- */
.annota-help {
  position: fixed;
  left: 50%;
  bottom: 60px;
  transform: translateX(-50%);
  width: 300px;
  pointer-events: auto;
}
.annota-help table { width: 100%; border-collapse: collapse; padding: 4px 12px 10px; }
.annota-help td { padding: 3px 0; font-size: 12px; color: #475569; }
.annota-help td:first-child { width: 72px; }
.annota-kbd {
  display: inline-block;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 0 5px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  font-weight: 700;
  color: #334155;
}

/* ---------- toast (transient overlay errors — never silent) ---------- */
.annota-toast {
  position: fixed;
  top: 12px;
  right: 14px;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  background: #fef2f2;
  color: #991b1b;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 600;
  max-width: 380px;
  box-shadow: 0 6px 22px rgba(15, 23, 42, .14);
  z-index: 2;
}
.annota-toast .annota-btn { border: none; background: transparent; padding: 0 4px; cursor: pointer; color: inherit; }

/* ---------- flash highlight (target element in the STORY dom) ---------- */
@keyframes annota-flash {
  0% { box-shadow: 0 0 0 0 rgba(79, 70, 229, .55); }
  25% { box-shadow: 0 0 0 5px rgba(79, 70, 229, .35), 0 0 22px 4px rgba(79, 70, 229, .3); }
  100% { box-shadow: 0 0 0 14px rgba(79, 70, 229, 0), 0 0 40px 12px rgba(79, 70, 229, 0); }
}
[data-annota-flash] { animation: annota-flash 1.5s cubic-bezier(.16,.84,.44,1) 2 !important; }
`;

let injected = false;

export function injectOverlayCss(): void {
  if (injected || typeof document === 'undefined') return;
  if (document.getElementById('annota-overlay-style')) {
    injected = true;
    return;
  }
  const style = document.createElement('style');
  style.id = 'annota-overlay-style';
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
  injected = true;
}
