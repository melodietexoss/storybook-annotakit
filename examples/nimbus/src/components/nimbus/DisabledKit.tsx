import { useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * DisabledKit — greyed-out / hit-blocked surfaces for exercising the pin
 * hit-tester (S6): the four real-world "greyed out" patterns. All are VISUALLY
 * present but interactively dead, which is exactly the class of element a
 * reviewer needs to pin ("this disabled state is wrong") — and the class that
 * defeats naive click capture (disabled controls swallow events; pe:none
 * sections are transparent to hit-testing).
 *
 *  1. button[disabled]        — native disabled: no click events fire on it
 *  2. input/select[disabled]  — native disabled form fields
 *  3. .locked (pe:none)       — a greyed "locked" section (common SaaS pattern)
 *  4. aria-disabled div       — non-native disabled styling
 *  5. disabled tooltip host   — disabled control whose tooltip portals to body
 */
export function DisabledKit() {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  return (
    <div style={{ fontFamily: 'system-ui', padding: 24, display: 'grid', gap: 16, justifyItems: 'start' }}>
      <h3 style={{ margin: 0 }}>Greyed-out / hit-blocked surfaces</h3>
      <p style={{ margin: 0, color: '#555', maxWidth: 540 }}>
        Every element below is visually present but interactively dead. Pinning any of them is the review case —
        a naive click listener never fires on native-disabled controls, and a pe:none section is transparent to
        hit-testing.
      </p>

      {/* 1 + 2: native disabled */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          disabled
          data-testid="disabled-button"
          style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#eef0f4', color: '#9aa2b1', font: '600 13px system-ui' }}
        >
          Save changes
        </button>
        <input
          disabled
          data-testid="disabled-input"
          placeholder="API key (revoked)"
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#eef0f4', color: '#9aa2b1', font: '13px system-ui' }}
        />
        <select disabled data-testid="disabled-select" style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#eef0f4', color: '#9aa2b1', font: '13px system-ui' }}>
          <option>Workspace…</option>
        </select>
        <input
          type="password"
          data-testid="secret-input"
          defaultValue="hunter2-super-secret"
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#fff', font: '13px system-ui' }}
        />
      </div>

      {/* 3: greyed locked section via pointer-events:none */}
      <div
        data-testid="locked-section"
        style={{ pointerEvents: 'none', opacity: 0.55, padding: '12px 16px', borderRadius: 10, border: '1px solid #d5dae3', background: '#f6f7fa', filter: 'grayscale(0.4)', maxWidth: 420 }}
      >
        <div style={{ font: '600 13px system-ui', color: '#6b7280', marginBottom: 6 }}>🔒 Billing (locked)</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button data-testid="locked-button" style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #c7cdd8', background: '#fff', font: '600 12px system-ui' }}>
            Edit plan
          </button>
          <span data-testid="locked-price" style={{ font: '600 12px system-ui', color: '#6b7280', alignSelf: 'center' }}>
            $148/mo
          </span>
        </div>
      </div>

      {/* 4: aria-disabled (non-native) */}
      <div
        role="button"
        aria-disabled="true"
        data-testid="aria-disabled-button"
        style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#eef0f4', color: '#9aa2b1', font: '600 13px system-ui', cursor: 'not-allowed' }}
      >
        Delete workspace
      </div>

      {/* 5: disabled control with a body-portal tooltip (frozen-view variant of the case) */}
      <div style={{ position: 'relative' }}>
        <button
          disabled
          data-testid="disabled-tip-host"
          onMouseEnter={(e) => setTip({ x: e.clientX, y: e.clientY })}
          style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#eef0f4', color: '#9aa2b1', font: '600 13px system-ui' }}
        >
          Disabled action
        </button>
        {tip &&
          createPortal(
            <div
              data-testid="disabled-tip"
              style={{ position: 'fixed', left: tip.x + 12, top: tip.y - 8, background: '#1f2430', color: '#fff', padding: '6px 10px', borderRadius: 6, font: '600 12px system-ui', zIndex: 2147483000, pointerEvents: 'none' }}
            >
              This action needs an owner
            </div>,
            document.body,
          )}
      </div>
    </div>
  );
}
