/**
 * Approval broker: turns `approval-request`s (from the C1 socket, i.e. the MCP server's safety gate) into Allow/Deny
 * cards in the panel and resolves them with the human's decision.
 *
 * Fail-closed everywhere: timeout, cancellation, renderer reload, shutdown and unknown ids all mean "deny".
 */
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, PanelCommand, RiskLevel } from '../../shared/protocol';

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
export const MIN_APPROVAL_TIMEOUT_MS = 1_000;
export const MAX_APPROVAL_TIMEOUT_MS = 30 * 60_000;
export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export interface ApprovalInput {
  tool: string;
  input: unknown;
  summary: string;
  risk: RiskLevel;
  reason?: string;
  timeoutMs?: number;
  source: ApprovalRequest['source'];
}

export interface ApprovalOutcome {
  decision: 'allow' | 'deny';
  message?: string;
}

interface Pending {
  request: ApprovalRequest;
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
}

export interface ApprovalBrokerOptions {
  /** Delivers `approval-request` / `approval-cancelled` commands to the panel renderer. */
  sendCommand: (command: PanelCommand) => void;
  newId?: () => string;
}

export function clampApprovalTimeout(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return DEFAULT_APPROVAL_TIMEOUT_MS;
  return Math.min(MAX_APPROVAL_TIMEOUT_MS, Math.max(MIN_APPROVAL_TIMEOUT_MS, Math.round(ms)));
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly newId: () => string;

  constructor(private readonly opts: ApprovalBrokerOptions) {
    this.newId = opts.newId ?? randomUUID;
  }

  /** Requests currently waiting for a human decision. */
  list(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * Shows an approval card and resolves with the decision. Aborting `signal` (e.g. the socket client hung up)
   * cancels the card and resolves "deny".
   */
  request(input: ApprovalInput, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const request: ApprovalRequest = {
      id: this.newId(),
      tool: input.tool,
      input: input.input,
      summary: input.summary,
      risk: RISK_LEVELS.includes(input.risk) ? input.risk : 'high',
      ...(input.reason ? { reason: input.reason } : {}),
      source: input.source,
      timeoutMs: clampApprovalTimeout(input.timeoutMs),
    };
    if (signal?.aborted) return Promise.resolve({ decision: 'deny', message: 'Request was cancelled' });

    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.cancel(request.id, 'No decision was made in time'), request.timeoutMs);
      const entry: Pending = { request, resolve, timer };
      if (signal) {
        entry.signal = signal;
        entry.onAbort = () => this.cancel(request.id, 'Request was cancelled');
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.pending.set(request.id, entry);
      this.opts.sendCommand({ type: 'approval-request', request });
    });
  }

  /** Applies the human's decision. Returns false for unknown/expired ids (which are ignored). */
  respond(decision: ApprovalDecision): boolean {
    const entry = this.pending.get(decision.id);
    if (!entry) return false;
    this.settle(entry, {
      decision: decision.decision === 'allow' ? 'allow' : 'deny',
      ...(decision.message ? { message: decision.message } : {}),
    });
    return true;
  }

  /** Denies one pending request and removes its card. */
  cancel(id: string, message: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.settle(entry, { decision: 'deny', message });
    this.opts.sendCommand({ type: 'approval-cancelled', id });
  }

  /** Denies every pending request (shutdown, renderer reload). */
  cancelAll(message: string): void {
    for (const id of [...this.pending.keys()]) this.cancel(id, message);
  }

  private settle(entry: Pending, outcome: ApprovalOutcome): void {
    this.pending.delete(entry.request.id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.resolve(outcome);
  }
}
