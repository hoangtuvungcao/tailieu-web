import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import {
  badges,
  leaderboardRunningTotals,
  reputationEvents,
  userBadges,
  users,
} from '../../../db/schema/index.js';
import type { Executor, Tx } from '../../documents/documents.repository.js';
import { monthKey } from '../shared/periods.js';

/**
 * Reputation data access.
 *
 * `reputation_events` is append-only and is the source of truth. Everything
 * else — the per-period leaderboard totals, the profile's headline number — is
 * derived from it, which is what makes a wrong derived value repairable rather
 * than lost.
 */

export type ReputationReason =
  | 'document_published'
  | 'like_received'
  | 'comment_like_received'
  | 'rating_received'
  | 'moderation_penalty'
  | 'spam_penalty'
  | 'manual_adjust';

export interface EventInput {
  userId: string;
  delta: number;
  reason: ReputationReason;
  actorUserId: string | null;
  sourceType?: 'document' | 'post' | 'comment' | 'collection' | 'user' | null;
  sourceId?: string | null;
  dedupeKey: string | null;
}

/**
 * Write one event, or nothing if an identical one already exists.
 *
 * Returns false on a dedupe collision rather than throwing: a retried award is
 * a no-op by design, and turning that into an error would make an idempotent
 * retry look like a failure.
 */
export async function insertEvent(tx: Tx, input: EventInput): Promise<boolean> {
  const inserted = await tx
    .insert(reputationEvents)
    .values({
      userId: input.userId,
      delta: input.delta,
      reason: input.reason,
      actorUserId: input.actorUserId,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      dedupeKey: input.dedupeKey,
    })
    .onConflictDoNothing()
    .returning({ id: reputationEvents.id });

  return inserted.length > 0;
}

/**
 * How much positive reputation this account has received in the window.
 *
 * `actorUserId` narrows it to what one particular giver has contributed, which
 * is the per-relationship cap. Negative events are excluded on purpose: a
 * penalty should never eat into the headroom that limits praise.
 */
export async function positiveSince(
  executor: Executor,
  userId: string,
  since: Date,
  actorUserId?: string,
): Promise<number> {
  const predicates = [
    eq(reputationEvents.userId, userId),
    gt(reputationEvents.delta, 0),
    gt(reputationEvents.createdAt, since),
  ];
  if (actorUserId) predicates.push(eq(reputationEvents.actorUserId, actorUserId));

  const [row] = await executor
    .select({ value: sql<number>`coalesce(sum(${reputationEvents.delta}), 0)::int` })
    .from(reputationEvents)
    .where(and(...predicates));

  return Number(row?.value ?? 0);
}

/**
 * The account's all-time reputation.
 *
 * A `sum` over this account's own events, not a stored column. It is bounded by
 * how much that person has done rather than by the size of the table, so it
 * stays cheap — and unlike a column it cannot drift, so there is no reconcile
 * query to forget to run.
 */
export async function totalFor(executor: Executor, userId: string): Promise<number> {
  const [row] = await executor
    .select({ value: sql<number>`coalesce(sum(${reputationEvents.delta}), 0)::int` })
    .from(reputationEvents)
    .where(eq(reputationEvents.userId, userId));

  return Number(row?.value ?? 0);
}

/** How many events this account has, for the profile's activity line. */
export async function countFor(executor: Executor, userId: string): Promise<number> {
  const [row] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(reputationEvents)
    .where(eq(reputationEvents.userId, userId));

  return Number(row?.value ?? 0);
}

/**
 * Add one event's points to the running leaderboard totals.
 *
 * A bounded number of rows per event — the university row, plus the account's
 * faculty and programme if it has them. The alternative, `sum(delta) ... GROUP
 * BY user_id` over a period, is O(events in the period) and becomes the slowest
 * query in the system exactly when the platform succeeds.
 *
 * `periodKey` is the calendar month. `all_time` is not maintained here: the
 * profile's total comes from `totalFor`, and a second representation of the
 * same number is a second thing that can disagree.
 */
export async function addRunningTotals(
  tx: Tx,
  userId: string,
  delta: number,
  at: Date,
): Promise<void> {
  const [account] = await tx
    .select({
      facultyId: users.primaryFacultyId,
      programId: users.primaryProgramId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!account) return;

  // Imported rather than formatted here: the leaderboard reader derives its
  // key the same way, and two copies of this format would let them disagree.
  const periodKey = monthKey(at);

  const scopes: { scopeType: 'university' | 'faculty' | 'program'; scopeId: string | null }[] = [
    { scopeType: 'university', scopeId: null },
  ];
  if (account.facultyId) scopes.push({ scopeType: 'faculty', scopeId: account.facultyId });
  if (account.programId) scopes.push({ scopeType: 'program', scopeId: account.programId });

  for (const scope of scopes) {
    await tx
      .insert(leaderboardRunningTotals)
      .values({
        periodType: 'monthly',
        periodKey,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        userId,
        score: String(delta),
      })
      .onConflictDoUpdate({
        // Must name the primary key's columns, NULLS NOT DISTINCT included, or
        // the university row (`scope_id IS NULL`) would not be recognised as a
        // conflict and every event would insert another row instead of adding
        // to the one that is there.
        target: [
          leaderboardRunningTotals.periodType,
          leaderboardRunningTotals.periodKey,
          leaderboardRunningTotals.scopeType,
          leaderboardRunningTotals.scopeId,
          leaderboardRunningTotals.userId,
        ],
        set: {
          score: sql`${leaderboardRunningTotals.score} + ${delta}`,
          updatedAt: new Date(),
        },
      });
  }
}

// =============================================================================
// Badges
// =============================================================================

export interface BadgeRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  tier: number;
  category: string;
  criteria: unknown;
}

/** Active badges that have criteria to evaluate. */
export async function listAwardableBadges(
  executor: Executor,
  codes?: string[],
): Promise<BadgeRow[]> {
  const predicates = [sql`${badges.deletedAt} IS NULL`, eq(badges.isActive, true)];
  if (codes && codes.length > 0) {
    predicates.push(inArray(badges.code, codes));
  }

  return executor
    .select({
      id: badges.id,
      code: badges.code,
      name: badges.name,
      description: badges.description,
      icon: badges.icon,
      tier: badges.tier,
      category: badges.category,
      criteria: badges.criteria,
    })
    .from(badges)
    .where(and(...predicates));
}

/** Badge codes this account already holds and has not had revoked. */
export async function heldBadgeIds(executor: Executor, userId: string): Promise<Set<string>> {
  const rows = await executor
    .select({ badgeId: userBadges.badgeId })
    .from(userBadges)
    .where(and(eq(userBadges.userId, userId), sql`${userBadges.revokedAt} IS NULL`));

  return new Set(rows.map((row) => row.badgeId));
}

/**
 * Award a badge. Idempotent while it is held — the partial unique is on
 * `revoked_at IS NULL`, so a revoked badge can be earned again but a held one
 * cannot be duplicated.
 */
export async function awardBadge(
  tx: Tx,
  userId: string,
  badgeId: string,
  reason: string,
): Promise<boolean> {
  const inserted = await tx
    .insert(userBadges)
    .values({ userId, badgeId, awardReason: reason })
    .onConflictDoNothing()
    .returning({ id: userBadges.id });

  return inserted.length > 0;
}

export interface HeldBadgeRow {
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  tier: number;
  category: string;
  awardedAt: Date | string;
}

/** Badges this account holds, most recent first. */
export async function listHeldBadges(
  executor: Executor,
  userId: string,
): Promise<HeldBadgeRow[]> {
  const rows = await executor
    .select({
      code: badges.code,
      name: badges.name,
      description: badges.description,
      icon: badges.icon,
      tier: badges.tier,
      category: badges.category,
      awardedAt: userBadges.awardedAt,
    })
    .from(userBadges)
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .where(and(eq(userBadges.userId, userId), sql`${userBadges.revokedAt} IS NULL`))
    .orderBy(sql`${userBadges.awardedAt} DESC`);

  return rows;
}
