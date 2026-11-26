/**
 * Computer-control health check for the onboarding wizard: runs `claudeos-doctor --json` (system-config, C9) and
 * validates its output into a DoctorReport. Without the doctor (dev machines) a minimal in-process report is returned.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { DoctorCheck, DoctorReport } from '../../shared/protocol';
import { runCommand } from './auth';
import { findOnPath, isExecutableFile, resolveClaudeBinary, sanitizedEnv } from './claude-binary';
import type { SpawnFn } from './session-manager';

export const DOCTOR_FALLBACK_PATH = '/usr/lib/claudeos/claudeos-doctor';
const STATUSES: readonly DoctorCheck['status'][] = ['ok', 'warn', 'fail'];

export interface DoctorOptions {
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  isExec?: (path: string) => boolean;
  timeoutMs?: number;
}

export function findDoctor(env: NodeJS.ProcessEnv, isExec: (p: string) => boolean = isExecutableFile): string | null {
  return findOnPath('claudeos-doctor', env.PATH, isExec) ?? (isExec(DOCTOR_FALLBACK_PATH) ? DOCTOR_FALLBACK_PATH : null);
}

/** Validates doctor JSON. Malformed checks are dropped; `ok` is recomputed when missing. */
export function parseDoctorReport(stdout: string): DoctorReport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { checks?: unknown }).checks)) return null;
  const checks: DoctorCheck[] = [];
  for (const c of (raw as { checks: unknown[] }).checks) {
    if (typeof c !== 'object' || c === null) continue;
    const o = c as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.label !== 'string' || !STATUSES.includes(o.status as DoctorCheck['status'])) continue;
    checks.push({
      id: o.id,
      label: o.label,
      status: o.status as DoctorCheck['status'],
      ...(typeof o.detail === 'string' && o.detail ? { detail: o.detail } : {}),
      ...(typeof o.fix === 'string' && o.fix ? { fix: o.fix } : {}),
    });
  }
  const okField = (raw as { ok?: unknown }).ok;
  return { ok: typeof okField === 'boolean' ? okField : checks.every((c) => c.status !== 'fail'), checks };
}

/** Report produced without claudeos-doctor: says so, plus the checks the panel can do itself. */
export function fallbackReport(env: NodeJS.ProcessEnv, isExec: (p: string) => boolean = isExecutableFile, note?: string): DoctorReport {
  const claude = resolveClaudeBinary(env, isExec);
  const session = env.XDG_SESSION_TYPE ?? 'unknown';
  const checks: DoctorCheck[] = [
    {
      id: 'doctor',
      label: 'System check tool',
      status: 'warn',
      detail: note ?? 'claudeos-doctor is not installed, so only basic checks ran.',
      fix: 'Install the claudeos-core package (sudo apt install claudeos-core).',
    },
    claude
      ? { id: 'claude', label: 'Claude Code installed', status: 'ok' }
      : {
          id: 'claude',
          label: 'Claude Code installed',
          status: 'fail',
          detail: 'The claude command was not found.',
          fix: 'Run sudo /usr/lib/claudeos/install-claude-code.sh',
        },
    {
      id: 'session',
      label: 'Desktop session',
      status: session === 'wayland' || session === 'x11' ? 'ok' : 'warn',
      detail: `Session type: ${session}`,
    },
  ];
  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = sanitizedEnv(opts.env ?? process.env);
  const isExec = opts.isExec ?? isExecutableFile;
  const doctor = findDoctor(env, isExec);
  if (!doctor) return fallbackReport(env, isExec);
  const r = await runCommand(opts.spawn ?? (nodeSpawn as SpawnFn), doctor, ['--json'], env, opts.timeoutMs ?? 30_000);
  const report = parseDoctorReport(r.stdout);
  return report ?? fallbackReport(env, isExec, 'claudeos-doctor did not produce a readable report.');
}
