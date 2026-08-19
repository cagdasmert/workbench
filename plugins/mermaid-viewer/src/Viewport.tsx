import { useCallback, useEffect, useRef, useState } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

export interface View {
  zoom: number;
  x: number;
  y: number;
}

export const IDENTITY: View = { zoom: 1, x: 0, y: 0 };

const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * Pan/zoom surface for arbitrarily large diagrams.
 *
 * Everything here is plugin-local: the transform lives on a wrapper this
 * component owns, so no host API is involved and nothing about the panel
 * contract changes.
 */
export function Viewport({
  html,
  view,
  onView,
  children,
}: {
  html: string;
  view: View;
  onView: (next: View) => void;
  children?: React.ReactNode;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // Held in a ref, not state: the pointermove handler must not re-subscribe on
  // every frame, and the drag origin is not render-relevant.
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const surface = surfaceRef.current;
    if (surface === null) return;

    surface.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: view.x,
      originY: view.y,
    };
    setDragging(true);
  }, [view.x, view.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    onView({
      zoom: view.zoom,
      x: d.originX + (e.clientX - d.startX),
      y: d.originY + (e.clientY - d.startY),
    });
  }, [onView, view.zoom]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    surfaceRef.current?.releasePointerCapture(e.pointerId);
    drag.current = null;
    setDragging(false);
  }, []);

  // Wheel zoom anchored at the cursor, so the point under the pointer stays put.
  // Registered natively because React's onWheel is passive and cannot
  // preventDefault the page-level zoom gesture.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 2) return;
      e.preventDefault();

      const rect = surface.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      const factor = Math.exp(-e.deltaY * 0.002);
      const next = clamp(view.zoom * factor);
      const ratio = next / view.zoom;

      onView({
        zoom: next,
        x: px - (px - view.x) * ratio,
        y: py - (py - view.y) * ratio,
      });
    };

    surface.addEventListener('wheel', onWheel, { passive: false });
    return () => surface.removeEventListener('wheel', onWheel);
  }, [view, onView]);

  return (
    <div
      ref={surfaceRef}
      style={{ ...styles.surface, cursor: dragging ? 'grabbing' : 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        ref={contentRef}
        style={{
          ...styles.content,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
        }}
        // mermaid sanitises its own output at securityLevel 'strict'
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {children}
    </div>
  );
}

export { clamp, MIN_ZOOM, MAX_ZOOM };

const styles: Record<string, React.CSSProperties> = {
  surface: {
    position: 'relative',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    touchAction: 'none',
    userSelect: 'none',
    background: 'var(--workspace-bg, #fff)',
  },
  content: {
    position: 'absolute',
    top: 0,
    left: 0,
    transformOrigin: '0 0',
    willChange: 'transform',
  },
};
