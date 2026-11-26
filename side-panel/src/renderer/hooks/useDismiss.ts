import { type RefObject, useEffect } from 'react';

/**
 * Close a popover on Escape or a pointer-down outside `ref` (and outside `ignore`, typically the trigger button).
 * Escape is stopped here so the global "Escape hides the panel" shortcut does not also fire.
 */
export function useDismiss(
  open: boolean,
  onClose: () => void,
  ref: RefObject<HTMLElement | null>,
  ignore?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onPointer = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node | null;
      if (!t || ref.current?.contains(t) || ignore?.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onPointer, true);
    };
  }, [open, onClose, ref, ignore]);
}
