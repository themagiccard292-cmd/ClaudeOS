import type { ClaudeOSApi } from '../../shared/protocol';

/**
 * The renderer's only door to the outside world (preload bridge in Electron, the in-memory mock in a browser/tests).
 * Read lazily so tests can swap `window.claudeos` between cases.
 */
export function api(): ClaudeOSApi {
  return window.claudeos;
}
