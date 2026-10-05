import { db } from '../../../db/client.js';
import { isoDateTime } from '../shared/dates.js';
import type { Tx } from '../../documents/documents.repository.js';
import * as repo from './reputation.repository.js';

/**
 * Reputation.
 *
 * The design constraint is that a points system is a spam system unless every
 * rule is chosen against it. Four rules, each answering a specific way this
 * goes wrong:
 *
 *   1. NOTHING IS AWARDED FOR CREATING CONTENT. Uploading junk costs a farmer
 *      nothing and pays immediately, so `document_published` is worth zero.
 *      Every point below is earned only when *another person* acts on what you
 *      made — which means the cost of farming is convincing somebody else.
 *
 *   2. NOBODY CAN VOTE FOR THEMSELVES. Enforced here and by a CHECK constraint,
 *      so it holds even for a caller that forgets.
 *
 *   3. PRAISE IS CAPPED, PUNISHMENT IS NOT. A rolling 24-hour ceiling on what
 *      an account can receive, and a second, much lower ceiling on what any one
 *      account can contribute to another. A cap bounds farming exactly; a decay
 *      curve only discourages it.
 *
 *   4. BADGES NEVER PAY. A badge that granted points would itself become the
 *      target, and the two systems would amplify each other. Badges are
 *      decoration, and the schema says so.
 *
 * The window is a rolling 24 hours rather than a calendar day: a calendar day
 * has a timezone, and a farmer who knows the boundary simply waits for it.
 */

/**
 * What each event is worth, before the caps.
 *
 * `document_published` is deliberately zero — see rule 1 above. The enum value
 * exists and stays unused rather than being removed, so a future decision to
 * reward publishing has somewhere to land.
 */
export const BASE_POINTS: Record<repo.ReputationReason, number> = {
  like_received: 2,
  comment_like_received: 1,
  rating_received: 3,
  document_published: 0,
  moderation_penalty: -10,
  spam_penalty: -25,
  manual_adjust: 0,
};

/** No account gains more than this in any rolling 24 hours. */
const DAILY_RECEIVED_CAP = 100;

/**
 * No single account contributes more than this to one other in 24 hours.
 *
 * Much lower than the received cap on purpose: it is the ceiling on a mutual
 * admiration pair, and 20 a day is already far more than one classmate's
 * genuine appreciation of another.
 */
const DAILY_FROM_ACTOR_CAP = 20;

const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface AwardInput {
  /** Who is being credited. */
  userId: string;
  reason: repo.ReputationReason;
  /** Who caused it. Null for a system action such as a moderation decision. */
  actorUserId?: string | null;
  sourceType?: 'document' | 'post' | 'comment' | 'collection' | 'user' | null;
  sourceId?: string | null;
  /**
   * Makes the award idempotent. Use `'<event>:<sourceType>:<id>:v1'` — the
   * version suffix is what lets a change to the rules re-award deliberately
   * instead of accidentally.
   */
  dedupeKey?: string | null;
  /** Overrides `BASE_POINTS`. For moderation, where the amount is a decision. */
  points?: number;
}

/**
 * Credit or debit one account, inside the caller's transaction.
 *
 * Returns the points actually written — which may be less than requested when
 * a cap bites, and zero when the event was refused or already recorded. Callers
 * that do not care can ignore it; a caller that reports the number to a user
 * should use this value rather than the requested one.
 */
export async function award(tx: Tx, input: AwardInput): Promise<number> {
  const actorUserId = input.actorUserId ?? null;

  // Rule 2. The CHECK constraint refuses this at the database too; returning
  // early spares every caller from having to remember.
  if (actorUserId && actorUserId === input.userId) return 0;

  let points = input.points ?? BASE_POINTS[input.reason];
  if (points === 0) return 0;

  if (points > 0) {
    const since = new Date(Date.now() - WINDOW_MS);

    // Both caps are read, then the smaller headroom wins. Reading them as a
    // pair rather than in sequence matters: the second read must not see the
    // effect of the first, which has not been written yet.
    const [received, fromActor] = await Promise.all([
      repo.positiveSince(tx, input.userId, since),
      actorUserId
        ? repo.positiveSince(tx, input.userId, since, actorUserId)
        : Promise.resolve(0),
    ]);

    let headroom = DAILY_RECEIVED_CAP - received;
    if (actorUserId) headroom = Math.min(headroom, DAILY_FROM_ACTOR_CAP - fromActor);

    // Clamped rather than skipped: a partial credit is honest, whereas dropping
    // the event silently would leave an action that "worked" with no trace.
    points = Math.min(points, headroom);
    if (points <= 0) return 0;
  }

  const written = await repo.insertEvent(tx, {
    userId: input.userId,
    delta: points,
    reason: input.reason,
    actorUserId,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    dedupeKey: input.dedupeKey ?? null,
  });

  // Already recorded. Not an error: a retried award is meant to be a no-op,
  // which is the entire purpose of the dedupe key.
  if (!written) return 0;

  await repo.addRunningTotals(tx, input.userId, points, new Date());
  await evaluateBadges(tx, input.userId);

  return points;
}

/**
 * Revoke something that was credited, as a negative event.
 *
 * Deliberately larger than the original award, and never merely a deletion of
 * it: the credit has already been counted by whoever saw it, and a score that
 * can only go up means the cheapest strategy is to post first and apologise
 * later. A debit the author can see going below zero is what makes that
 * strategy cost something.
 *
 * The amount is the caller's judgement, so it is passed in rather than derived.
 */
export async function revoke(
  tx: Tx,
  input: Omit<AwardInput, 'points'> & { points: number },
): Promise<number> {
  return award(tx, { ...input, points: -Math.abs(input.points) });
}

// =============================================================================
// Badges
// =============================================================================

/**
 * Award every badge whose criteria this account now meets.
 *
 * Lazy, evaluated when a reputation event is written. A threshold can only be
 * crossed by a reputation event, so evaluating at that moment is complete —
 * which means no cron job, and no window in which an account has earned a badge
 * it does not yet show.
 */
async function evaluateBadges(tx: Tx, userId: string): Promise<void> {
  const candidates = await repo.listAwardableBadges(tx);
  if (candidates.length === 0) return;

  const held = await repo.heldBadgeIds(tx, userId);

  for (const badge of candidates) {
    if (held.has(badge.id)) continue;

    const criteria = badge.criteria as { metric?: string; threshold?: number } | null;
    if (!criteria || typeof criteria.threshold !== 'number') continue;

    const value = await metricValue(tx, userId, criteria.metric);
    if (value === null || value < criteria.threshold) continue;

    await repo.awardBadge(tx, userId, badge.id, `${criteria.metric} >= ${criteria.threshold}`);
  }
}

/**
 * The value a badge's criterion is measured against.
 *
 * An unrecognised metric returns null, which awards nothing. A badge firing on
 * a metric nobody implemented would be worse than one that never fires: nobody
 * would think to look for it.
 */
async function metricValue(
  tx: Tx,
  userId: string,
  metric: string | undefined,
): Promise<number | null> {
  switch (metric) {
    case 'reputation':
      return repo.totalFor(tx, userId);
    case 'event_count':
      return repo.countFor(tx, userId);
    default:
      return null;
  }
}

// =============================================================================
// Reads
// =============================================================================

export interface BadgeDto {
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
  tier: number;
  category: string;
  awardedAt: string;
}

export interface ReputationSummary {
  /** All-time total. May be negative — a penalised account can go below zero. */
  reputation: number;
  badges: BadgeDto[];
}

/**
 * Reputation and badges for a profile.
 *
 * Not viewer-filtered, unlike the post and document counts: reputation is not
 * content, and there is nothing to withhold. What another reader may see of
 * your posts has no bearing on whether you have the "100 points" badge.
 */
export async function summaryFor(userId: string): Promise<ReputationSummary> {
  const [reputation, badges] = await Promise.all([
    repo.totalFor(db, userId),
    repo.listHeldBadges(db, userId),
  ]);

  return {
    reputation,
    badges: badges.map((badge) => ({
      code: badge.code,
      name: badge.name,
      description: badge.description,
      icon: badge.icon,
      tier: badge.tier,
      category: badge.category,
      awardedAt: isoDateTime(badge.awardedAt),
    })),
  };
}
