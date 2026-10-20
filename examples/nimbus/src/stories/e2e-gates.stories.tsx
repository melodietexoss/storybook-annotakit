/**
 * Nimbus E2E fixtures — the v0.6.13 usability-round gate rows
 * (.agents/reference/e2e-gates.md rows 4/5/7/9/11/12/13/16). Demo-only
 * surface: the gate rows need stories with EXPLICIT annotakit parameters
 * (frame neutralization, hotkeys:false, remapped + degenerate specs), a
 * portal-collision shape (the P2-3 steal candidate), and a tall no-overflow
 * shape (the DD-17a/b scroll + squeeze rows). No kit code depends on these
 * stories.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Meta, StoryObj } from '@storybook/react-vite';

type Story = StoryObj;

const wrap: React.CSSProperties = {
  fontFamily: 'system-ui',
  padding: 24,
  display: 'grid',
  gap: 14,
  justifyItems: 'start',
  background: '#fff',
  minHeight: 120,
};

const btn: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px solid #c7cdd8',
  background: '#fff',
  cursor: 'pointer',
  font: '600 13px system-ui',
};

/**
 * Row 4 (DD-3c): recall-path frame neutralization. The srcdoc frame must
 * RENDER at recall (sandbox="", scripts dead — the inline script tries to
 * mark the parent; sandboxed, it never runs); embed/object become honest
 * placeholder comments. The freeze path keeps all three live by design.
 */
export const FramesStory: Story = {
  name: 'Frames — srcdoc + embed + object',
  render: () => (
    <div style={wrap}>
      <h3 style={{ margin: 0 }}>Frames — srcdoc iframe, embed, object</h3>
      <iframe
        title="srcdoc frame"
        style={{ width: 320, height: 110, border: '2px solid #c7cdd8', background: '#fff' }}
        srcDoc={
          '<div style="font:700 26px system-ui;padding:20px;color:#0f766e">SRCDOC-RENDERS-OK</div>' +
          '<div id="t48s" style="font:700 18px monospace;padding:0 20px 20px;color:#9a3412">SCRIPTS-DEAD-HERE</div>' +
          // The freeze path keeps this frame LIVE (by design) — the script
          // flips the line to SCRIPTS-RAN. At recall, sandbox="" must keep it
          // at SCRIPTS-DEAD-HERE (visual, screenshot-verifiable — a sandboxed
          // frame's DOM is unreadable from the parent).
          '<script>document.getElementById("t48s").textContent="SCRIPTS-RAN";parent.__t48SrcdocRecallRan=1</script>'
        }
      />
      <embed
        title="embed frame"
        style={{ width: 200, height: 60, border: '1px dashed #94a3b8' }}
        src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='60'><rect width='200' height='60' fill='%23e0f2fe'/><text x='12' y='36' font-family='monospace' font-size='16'>EMBED-BODY</text></svg>"
        type="image/svg+xml"
      />
      <object
        title="object frame"
        style={{ width: 200, height: 60, border: '1px dashed #94a3b8' }}
        data="data:text/html,<b>OBJECT-BODY</b>"
        type="text/html"
      >
        object-fallback
      </object>
    </div>
  ),
};

/**
 * Row 7 (P2-3's scored half): portal collision. The amber story label
 * "Duplicate" is the steal candidate; the fixed-position portal menu item
 * carries the SAME text at a clearly different position. Pin the PORTAL item
 * inside a frozen view — the resolve must never jump to the story's copy
 * (textQuoteGate bbox scoring) — and after thaw (menu closed) the pin must
 * be a live orphan.
 */
function PortalCollision() {
  const [open, setOpen] = useState(false);
  return (
    <div style={wrap}>
      <h3 style={{ margin: 0 }}>Portal collision — pin the menu item, not this label</h3>
      <span
        data-testid="dup-label"
        style={{ display: 'inline-block', padding: '10px 14px', background: '#fef3c7', border: '1px solid #d97706', font: '600 14px system-ui' }}
      >
        Duplicate
      </span>
      <p style={{ margin: 0, color: '#555', maxWidth: 560 }}>
        Open the menu, freeze, pin the menu&apos;s &quot;Duplicate&quot; row. The pin must stay on the menu clone — never on the amber label above. After thaw
        (Esc closes the menu and the view together) the pin goes live-orphan.
      </p>
      <button data-testid="pc-open" onClick={() => setOpen((o) => !o)} style={btn}>
        Toggle menu
      </button>
      {open &&
        createPortal(
          <div
            data-testid="pc-menu"
            style={{
              position: 'fixed',
              left: 340,
              top: 430,
              zIndex: 9999,
              background: '#fff',
              border: '1px solid #d3d8e2',
              borderRadius: 10,
              boxShadow: '0 12px 32px rgba(15,23,42,.18)',
              padding: 6,
              minWidth: 220,
            }}
          >
            <div data-testid="pc-item" style={{ padding: '9px 12px', borderRadius: 6, font: '600 15px system-ui' }}>
              Duplicate
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export const PortalCollisionStory: Story = {
  name: 'Portal Collision',
  render: () => <PortalCollision />,
};

/**
 * Rows 12/13 (DD-17d + parseHotkey spellings): remapped hotkeys with the
 * tolerant SPACED spelling — the manager strings must render ⌥K (never
 * "⌥+ K") and the chord must FIRE. Pin the note, then remove it: the pin
 * goes orphan and the panel's count line must say so across an addon-tab
 * switch (the lastUiState cache seeds the remount).
 */
function RemapKit() {
  const [note, setNote] = useState(true);
  return (
    <div style={wrap}>
      <h3 style={{ margin: 0 }}>Remapped hotkeys — pin ⌥K, region ⌥G, freeze ⌥U</h3>
      <p style={{ margin: 0, color: '#555', maxWidth: 560 }}>
        Pin the note below (⌥K + click), then remove it — the pin goes orphan and the panel&apos;s count line says so.
      </p>
      {note && (
        <p
          data-testid="remap-note"
          style={{ margin: 0, padding: '10px 14px', background: '#eef2ff', border: '1px solid #6366f1', font: '600 14px system-ui' }}
        >
          Remap target — pin me, then remove me
        </p>
      )}
      <button data-testid="remap-remove" onClick={() => setNote(false)} style={btn}>
        Remove the note (orphans the pin)
      </button>
    </div>
  );
}

const REMAP_PARAMS = { annotakit: { hotkeys: { pin: 'alt + k', region: 'alt+g', freeze: 'alt+u' } } };

export const RemapStory: Story = {
  name: 'Remapped Hotkeys',
  render: () => <RemapKit />,
  parameters: REMAP_PARAMS,
};

export const RemapEmptyStory: Story = {
  name: 'Remapped Hotkeys Empty',
  render: () => (
    <div style={wrap}>
      <h3 style={{ margin: 0 }}>No threads here — the empty-state letters must read ⌥K / ⌥G</h3>
    </div>
  ),
  parameters: REMAP_PARAMS,
};

/** Row 16 (44-c P3-2): degenerate specs — 'alt+' and a whitespace-only form
 *  must bind the DEFAULT chords (⌥C / ⌥B), note the substitution honestly,
 *  and never label a chord that does not exist. */
export const DegenerateStory: Story = {
  name: 'Degenerate Hotkeys',
  render: () => (
    <div style={wrap}>
      <h3 style={{ margin: 0 }}>Degenerate specs — pin &quot;alt+&quot;, region whitespace-only</h3>
      <p data-testid="deg-target" style={{ margin: 0, padding: '10px 14px', background: '#f1f5f9', border: '1px solid #94a3b8', font: '600 14px system-ui' }}>
        The default ⌥C / ⌥B must bind here; the labels must say so.
      </p>
    </div>
  ),
  parameters: { annotakit: { hotkeys: { pin: 'alt+', region: '   ' } } },
};

/** Rows 9/11 (DD-17a/b): a story taller than the viewport with NO horizontal
 *  overflow — the frozen container must be explorable, a pin from the frozen
 *  view must recall at the EXACT frozen-time exploration scroll, and on a
 *  classic-scrollbar platform the frozen view must show no dead horizontal
 *  strip (the DD-17b squeeze). The per-section labels make the restored
 *  scroll position screenshot-verifiable. */
const TALL_SECTIONS = ['TALL-S1', 'TALL-S2', 'TALL-S3', 'TALL-S4', 'TALL-S5', 'TALL-S6', 'TALL-S7', 'TALL-S8'];

export const TallStory: Story = {
  name: 'Tall — scroll + no horizontal overflow',
  render: () => (
    <div style={{ ...wrap, minHeight: undefined, gap: 0, padding: 0 }}>
      {TALL_SECTIONS.map((label, i) => (
        <section
          key={label}
          data-testid={'tall-' + label.toLowerCase()}
          style={{
            height: '40vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            font: '700 28px system-ui',
            color: '#0f172a',
            background: i % 2 === 0 ? '#f8fafc' : '#e2e8f0',
            borderTop: '1px solid #cbd5e1',
          }}
        >
          {label} — the frozen/recalled scroll anchor
        </section>
      ))}
    </div>
  ),
};

/** Row 5 (DD-18a / 33-e P2-1): hotkeys === false — the Esc cascade. Freeze
 *  via the toolbar, open a pin card, and the FIRST Esc must close the card
 *  (no thaw under it); the second thaws. */
export const NoHotkeysStory: Story = {
  name: 'No Hotkeys',
  render: () => (
    <div style={wrap}>
      <h3 style={{ margin: 0 }}>Hotkeys off — toolbar only; Esc closes the card before the thaw</h3>
      <p data-testid="nh-target" style={{ margin: 0, padding: '10px 14px', background: '#ecfdf5', border: '1px solid #059669', font: '600 14px system-ui' }}>
        Pin me from the toolbar
      </p>
    </div>
  ),
  parameters: { annotakit: { hotkeys: false } },
};

const meta = {
  title: 'Nimbus/E2E Gates',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
