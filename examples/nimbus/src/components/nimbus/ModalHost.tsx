import { useEffect, useRef, useState } from 'react';

/**
 * ModalHost — a deliberately STANDARD modal implementation (focus trap +
 * outside-click close + Escape close, the radix/headlessui pattern) for
 * exercising review flows against modal-type components: pinning elements
 * inside an open modal, typing in the annotakit composer while a trap is
 * active, and backdrop-click behavior. No portal on purpose — the story
 * canvas keeps the DOM inspectable.
 */
export function ModalHost() {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('input, button')?.focus();

    // focus trap: any focus outside the panel is pulled back in (radix
    // DismissableLayer / react-focus-lock behavior — the industry standard)
    const trap = (e: FocusEvent) => {
      if (panel && e.target instanceof Node && !panel.contains(e.target)) {
        setLog((l) => [...l.slice(-4), `trap: stole focus back from ${(e.target as HTMLElement).tagName}.${String((e.target as HTMLElement).className).slice(0, 30)}`]);
        panel.querySelector<HTMLElement>('input, button')?.focus();
      }
    };
    document.addEventListener('focusin', trap);
    return () => document.removeEventListener('focusin', trap);
  }, [open]);

  return (
    <div style={{ fontFamily: 'system-ui', padding: 24, display: 'grid', gap: 12, justifyItems: 'start' }}>
      <h3 style={{ margin: 0 }}>Settings — account section</h3>
      <p style={{ margin: 0, color: '#555', maxWidth: 480 }}>
        Open the dialog, then arm the annotakit pin (⌥C) and try to pin the <b>plan badge</b> or the input inside
        the modal. Watch where your keyboard input actually lands.
      </p>
      <button
        ref={triggerRef}
        onClick={() => setOpen(true)}
        style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#fff', cursor: 'pointer' }}
      >
        Delete account…
      </button>

      {open && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,18,25,.45)', display: 'grid', placeItems: 'center', zIndex: 60 }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) {
              setLog((l) => [...l.slice(-4), 'backdrop: outside-click → modal closed']);
              setOpen(false);
            }
          }}
        >
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            style={{ background: '#fff', borderRadius: 12, padding: 20, width: 340, display: 'grid', gap: 12, boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}
          >
            <strong>Delete this account?</strong>
            <span style={{ background: '#eef2ff', color: '#3730a3', borderRadius: 999, padding: '2px 10px', justifySelf: 'start', fontSize: 13 }}>
              PRO plan — billed yearly
            </span>
            <label style={{ fontSize: 13, color: '#444' }}>
              Type DELETE to confirm
              <input
                style={{ width: '100%', marginTop: 4, padding: '6px 8px', borderRadius: 6, border: '1px solid #c7cdd8' }}
                placeholder="DELETE"
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setOpen(false)} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#fff', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={() => setOpen(false)} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer' }}>
                Delete forever
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ fontSize: 12, color: '#888', minHeight: 60 }}>
        {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>(modal event log — trap/outside-click activity shows here)</div>}
      </div>
    </div>
  );
}
