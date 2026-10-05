import type { Database } from '../db/client.js';
import { auditLogs } from '../db/schema/index.js';

/**
 * Audit logging.
 *
 * The important design decision: for security and administrative actions, the
 * audit row is written inside the SAME transaction as the change it describes,
 * via `recordAudit(tx, ...)`. A best-effort write after the fact loses exactly
 * the events you most need — the ones where the transaction failed halfway, or
 * the process died between the change and the log.
 *
 * For high-volume, low-stakes events (a document view, a search) that would be
 * wasteful, so those are not audited at all. `audit_logs` is for actions where
 * "who did this, and when" has to be answerable months later.
 *
 * Rows are never deleted by application code. Retention is a database concern
 * (partitioning on created_at), because an audit log an application can edit is
 * not an audit log.
 */

/** The transactional client handed to a `db.transaction` callback. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either a transaction or the plain database handle. */
export type AuditExecutor = Tx | Database;

export interface AuditEntry {
  /** Dotted action name, e.g. "documents.moderate.approve". */
  action: string;
  actorUserId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/**
 * Write an audit entry.
 *
 * Pass the transaction client whenever the caller is inside a transaction —
 * that is the whole point. `metadata` must never contain secrets, password
 * hashes, or full token values; it is readable by any admin with `audit.read`.
 */
export async function recordAudit(executor: AuditExecutor, entry: AuditEntry): Promise<void> {
  await executor.insert(auditLogs).values({
    action: entry.action,
    actorUserId: entry.actorUserId ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    requestId: entry.requestId ?? null,
  });
}

/**
 * Strip a record down to the fields worth keeping in an audit diff.
 *
 * Audit rows are read by humans investigating an incident, and dumping a whole
 * user row into `metadata` buries the two fields that changed under twenty that
 * did not — while also risking a password hash or token landing in the log.
 */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  fields: string[],
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const pick = (source: Record<string, unknown> | null) => {
    const out: Record<string, unknown> = {};
    if (!source) return out;
    for (const field of fields) {
      if (field in source) out[field] = source[field];
    }
    return out;
  };
  return { before: pick(before), after: pick(after) };
}
