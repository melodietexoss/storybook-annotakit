import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * PortalKit — deliberately STANDARD body-portal UI (the radix/floating-ui
 * pattern) for exercising the frozen view (S3): a context menu that closes on
 * outside interaction, a hover tooltip, and a hover popover. All three PORTAL
 * to document.body — outside #storybook-root, so they are exactly the class
 * of surface that vanishes the moment the cursor moves toward pin
 * affordances. The ONLY way to pin them is to freeze the view first (⌥F) —
 * the capture's body-portal sweep is the whole point of this story.
 */
export function PortalKit() {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const [pop, setPop] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const popAnchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const rectOf = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 });

  return (
    <div style={{ fontFamily: 'system-ui', padding: 24, display: 'grid', gap: 14, justifyItems: 'start' }}>
      <h3 style={{ margin: 0 }}>Portal surfaces — context menu, tooltip, popover</h3>
      <p style={{ margin: 0, color: '#555', maxWidth: 520 }}>
        Open the context menu or hover a trigger, then move the cursor toward the toolbar — the surface closes before
        you can pin it. Freeze the view first (⌥F) and it stays exactly as captured; pin it inside the frozen view.
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          data-testid="ctx-trigger"
          onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
          style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#fff', cursor: 'pointer', font: '600 13px system-ui' }}
        >
          Actions ▾
        </button>
        <button
          ref={anchorRef}
          data-testid="tip-trigger"
          onMouseEnter={() => setTip({ x: rectOf(anchorRef.current).left, y: rectOf(anchorRef.current).top - 36 })}
          onMouseLeave={() => setTip(null)}
          style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#fff', cursor: 'help', font: '600 13px system-ui' }}
        >
          Hover me
        </button>
        <button
          ref={popAnchorRef}
          data-testid="pop-trigger"
          onMouseEnter={() => setPop({ x: rectOf(popAnchorRef.current).left, y: rectOf(popAnchorRef.current).top + 40 })}
          onMouseLeave={() => setPop(null)}
          style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #c7cdd8', background: '#fff', cursor: 'pointer', font: '600 13px system-ui' }}
        >
          Details
        </button>
        <span
          data-testid="quota-pill"
          style={{ padding: '4px 10px', borderRadius: 999, background: '#eef2ff', color: '#3730a3', font: '600 12px system-ui' }}
        >
          quota: 68%
        </span>
      </div>

      {menu &&
        createPortal(
          <div
            ref={menuRef}
            data-testid="ctx-menu"
            style={{ position: 'fixed', left: menu.x, top: menu.y + 8, zIndex: 9999, background: '#fff', border: '1px solid #d3d8e2', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.18)', padding: 6, minWidth: 200 }}
          >
            {['Rename workspace', 'Archive project', 'Duplicate', 'Delete project'].map((label) => (
              <div
                key={label}
                data-testid="ctx-item"
                role="menuitem"
                tabIndex={0}
                style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', font: '500 13px system-ui' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#f1f5f9')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {label}
              </div>
            ))}
          </div>,
          document.body,
        )}
      {tip &&
        createPortal(
          <div
            data-testid="hover-tip"
            style={{ position: 'fixed', left: tip.x, top: tip.y, zIndex: 9999, background: '#0f172a', color: '#f8fafc', padding: '6px 10px', borderRadius: 8, font: '500 12px system-ui', pointerEvents: 'none' }}
          >
            Workspace quota resets on Nov 1
          </div>,
          document.body,
        )}
      {pop &&
        createPortal(
          <div
            data-testid="hover-pop"
            style={{ position: 'fixed', left: pop.x, top: pop.y, zIndex: 9999, background: '#fff', border: '1px solid #d3d8e2', borderRadius: 10, boxShadow: '0 12px 32px rgba(15,23,42,.18)', padding: 10, maxWidth: 260, font: '500 12px system-ui' }}
          >
            <b>Usage this cycle</b> — 6.8 / 10 GB synced. Large files count double after the first 5 GB.
          </div>,
          document.body,
        )}
    </div>
  );
}
