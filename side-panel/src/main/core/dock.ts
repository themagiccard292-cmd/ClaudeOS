/**
 * Right-docked panel geometry and X11 struts.
 *
 * The panel runs under XWayland (`--ozone-platform=x11`, ARCHITECTURE §1.1). When `reserveSpace` is on it publishes
 * `_NET_WM_STRUT_PARTIAL` (+ legacy `_NET_WM_STRUT`) through `xprop` so the window manager shrinks the work area of
 * other windows. This is best effort: missing xprop or a WM that ignores struts simply leaves the panel overlaying.
 */
import { execFile } from 'node:child_process';
import { clampPanelWidth } from '../../shared/protocol';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Panel bounds: right edge of the work area, full work-area height, clamped width. */
export function computePanelBounds(workArea: Rect, width: number): Rect {
  const w = clampPanelWidth(width, workArea.width);
  return { x: workArea.x + workArea.width - w, y: workArea.y, width: w, height: workArea.height };
}

/** The 12 cardinals of _NET_WM_STRUT_PARTIAL: left, right, top, bottom, then start/end pairs for each side. */
export type StrutPartial = [number, number, number, number, number, number, number, number, number, number, number, number];

export const ZERO_STRUT: StrutPartial = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Struts reserving `panel` on the right edge of the X screen.
 * @param panel panel bounds in DIPs
 * @param screenRightEdge right edge of the whole X root window in DIPs (max x+width over all displays)
 * @param scaleFactor DIP → X pixel factor
 */
export function computeStrut(panel: Rect, screenRightEdge: number, scaleFactor = 1): StrutPartial {
  const s = scaleFactor > 0 && Number.isFinite(scaleFactor) ? scaleFactor : 1;
  const right = Math.max(0, Math.round((screenRightEdge - panel.x) * s));
  const startY = Math.max(0, Math.round(panel.y * s));
  const endY = Math.max(startY, Math.round((panel.y + panel.height) * s) - 1);
  return [0, right, 0, 0, 0, 0, startY, endY, 0, 0, 0, 0];
}

/** Parses the X window id out of BrowserWindow.getNativeWindowHandle() (an XID, little-endian). */
export function xidFromHandle(handle: Buffer): number | null {
  if (handle.length >= 4) {
    const id = handle.readUInt32LE(0);
    return id > 0 ? id : null;
  }
  return null;
}

/** Runner for external commands (injected in tests). Must never throw. */
export type CommandRunner = (file: string, args: string[]) => Promise<boolean>;

export const defaultRunner: CommandRunner = (file, args) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 5000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });

/** argv for xprop setting both strut properties on window `xid`. */
export function strutArgs(xid: number, strut: StrutPartial): string[][] {
  const id = `0x${xid.toString(16)}`;
  const legacy = strut.slice(0, 4);
  return [
    ['-id', id, '-f', '_NET_WM_STRUT_PARTIAL', '32c', '-set', '_NET_WM_STRUT_PARTIAL', strut.join(', ')],
    ['-id', id, '-f', '_NET_WM_STRUT', '32c', '-set', '_NET_WM_STRUT', legacy.join(', ')],
  ];
}

/** Sets the struts via xprop. Returns false (never throws) when xprop is missing or fails. */
export async function setStrut(xid: number | null, strut: StrutPartial, run: CommandRunner = defaultRunner): Promise<boolean> {
  if (!xid) return false;
  let ok = true;
  for (const args of strutArgs(xid, strut)) {
    try {
      ok = (await run('xprop', args)) && ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}
