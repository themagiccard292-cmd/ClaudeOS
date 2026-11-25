import { PANEL_DEFAULT_WIDTH } from '../../shared/protocol';

/**
 * Width while dragging the panel's LEFT edge. The panel is docked right, so moving the pointer left (smaller x)
 * widens it: width = startWidth + (startX − currentX). Use screen coordinates — the window itself moves while
 * resizing, so client coordinates would drift. Clamping is the main process's job (`panel.setWidth` returns it).
 */
export function computeDragWidth(startWidth: number, startX: number, currentX: number): number {
  return Math.round(startWidth + (startX - currentX));
}

export const RESET_WIDTH = PANEL_DEFAULT_WIDTH;
/** Keyboard resize step (arrow keys on the focused handle). */
export const KEYBOARD_STEP = 16;
