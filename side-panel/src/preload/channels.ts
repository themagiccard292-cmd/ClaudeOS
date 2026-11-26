/**
 * Main ↔ preload channels that are an implementation detail of the bridge (not part of the renderer-facing
 * `ClaudeOSApi`, so they live outside src/shared/protocol.ts).
 */
export const PRELOAD_IPC = {
  /** preload → main: the renderer subscribed to panel commands; queued commands can be delivered now. */
  commandsReady: 'panel:commands-ready',
} as const;
