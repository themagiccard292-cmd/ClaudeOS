import { useCallback, useEffect, useRef, useState } from 'react';
import { PANEL_DEFAULT_WIDTH } from '../../shared/protocol';
import { api } from '../lib/api';
import { KEYBOARD_STEP, RESET_WIDTH, computeDragWidth } from '../lib/resize';

/**
 * Drag handle on the panel's left edge. Pointer Events + pointer capture; widths are sent to the main process at
 * most once per animation frame and the clamped width it returns becomes the new truth. Double-click resets.
 * Also keyboard operable (focus, then ←/→) as an ARIA window splitter.
 */
export function ResizeHandle({ initialWidth }: { initialWidth?: number }) {
  const widthRef = useRef(initialWidth ?? PANEL_DEFAULT_WIDTH);
  const [width, setWidth] = useState(initialWidth ?? PANEL_DEFAULT_WIDTH);
  const [limits, setLimits] = useState({ min: 340, max: 1100 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number; pointerId: number } | null>(null);
  const pending = useRef<number | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    api()
      .panel.getState()
      .then((s) => {
        if (!alive) return;
        widthRef.current = s.width;
        setWidth(s.width);
        setLimits({ min: s.minWidth, max: s.maxWidth });
      })
      .catch(() => undefined);
    const off = api().panel.onState((s) => {
      if (drag.current) return; // our own drag is the source of truth while it lasts
      widthRef.current = s.width;
      setWidth(s.width);
      setLimits({ min: s.minWidth, max: s.maxWidth });
    });
    return () => {
      alive = false;
      off();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  const apply = useCallback(async (requested: number) => {
    const applied = await api().panel.setWidth(requested);
    widthRef.current = applied;
    setWidth(applied);
    return applied;
  }, []);

  const persist = useCallback((w: number) => void api().settings.set({ panelWidth: w }), []);

  const flush = useCallback(() => {
    frame.current = null;
    if (pending.current === null) return;
    const w = pending.current;
    pending.current = null;
    void apply(w);
  }, [apply]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { startX: e.screenX, startWidth: widthRef.current, pointerId: e.pointerId };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    pending.current = computeDragWidth(d.startWidth, d.startX, e.screenX);
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  const endDrag = async (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    let final = widthRef.current;
    if (pending.current !== null) {
      final = await apply(pending.current);
      pending.current = null;
    }
    drag.current = null;
    setDragging(false);
    if (final !== d.startWidth) persist(final);
  };

  const reset = async () => {
    persist(await apply(RESET_WIDTH));
  };

  const onKeyDown = async (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowLeft' ? KEYBOARD_STEP : e.key === 'ArrowRight' ? -KEYBOARD_STEP : 0;
    if (e.key === 'Enter' || e.key === 'Home') {
      e.preventDefault();
      await reset();
      return;
    }
    if (!delta) return;
    e.preventDefault();
    persist(await apply(widthRef.current + delta));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      data-testid="resize-handle"
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => void reset()}
      onKeyDown={onKeyDown}
      className="no-drag group absolute inset-y-0 left-0 z-40 w-[7px] cursor-col-resize touch-none outline-none"
    >
      <span
        aria-hidden
        className={`absolute inset-y-0 left-0 w-px transition-colors duration-150 ${
          dragging ? 'bg-accent' : 'bg-line group-hover:bg-accent/70 group-focus-visible:bg-accent'
        }`}
      />
    </div>
  );
}
