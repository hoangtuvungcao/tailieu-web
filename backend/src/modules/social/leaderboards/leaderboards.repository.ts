import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { db } from '../../../db/client.js';
import { leaderboardRunningTotals, users } from '../../../db/schema/index.js';
import type { Executor } from '../../documents/documents.repository.js';

/**
 * Leaderboard reads.
 *
 * A top-N index scan over `leaderboard_running_totals`, which is what that
 * table exists for: the obvious alternative — `sum(delta) ... GROUP BY user_id
 * ORDER BY 2 DESC` over `reputation_events` — is O(events in the period) plus
 * an aggregate plus a sort, and it gets slower every day the platform is used.
 *
 * The running totals are maintained by the reputation service, in the same
 * transaction as the event that moved them, so the board cannot lag the score.
 */

export type LeaderboardScope = 'university' | 'faculty' | 'program';

export interface LeaderboardEntryRow {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  score: number;
}

/**
 * The rows belonging to one board.
 *
 * `scopeId === null` means the university-wide board, whose rows are stored
 * with `scope_id IS NULL`. Using `= NULL` there would match nothing — and the
 * failure is a permanently empty university leaderboard with no error, which is
 * why this is one function rather than the condition inlined at each call site.
 */
function board(
  periodKey: string,
  scopeType: LeaderboardScope,
  scopeId: string | null,
): SQL {
  return and(
    eq(leaderboardRunningTotals.periodType, 'monthly'),
    eq(leaderboardRunningTotals.periodKey, periodKey),
    eq(leaderboardRunningTotals.scopeType, scopeType),
    scopeId === null
      ? isNull(leaderboardRunningTotals.scopeId)
      : eq(leaderboardRunningTotals.scopeId, scopeId),
  )!;
}

/**
 * Rows that belong on a visible board.
 *
 * Positive only. A "top contributors" list including everyone sitting at zero
 * is not a ranking, it is a list of everyone who has ever been liked once and
 * then penalised back — or, worse once the board grows, of everybody.
 */
function visible(): SQL {
  return and(sql`${leaderboardRunningTotals.score} > 0`, isNull(users.anonymizedAt))!;
}

export async function topFor(
  periodKey: string,
  scopeType: LeaderboardScope,
  scopeId: string | null,
  limit: number,
  executor: Executor = db,
): Promise<LeaderboardEntryRow[]> {
  const rows = await executor
    .select({
      userId: leaderboardRunningTotals.userId,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      score: leaderboardRunningTotals.score,
    })
    .from(leaderboardRunningTotals)
    .innerJoin(users, eq(users.id, leaderboardRunningTotals.userId))
    .where(and(board(periodKey, scopeType, scopeId), visible()))
    // `user_id` breaks ties, so a page of equal scores has a stable order
    // rather than whatever the planner happens to return — which would make
    // the same board look different on two consecutive loads.
    .orderBy(desc(leaderboardRunningTotals.score), leaderboardRunningTotals.userId)
    .limit(limit);

  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

export interface Standing {
  rank: number;
  score: number;
}

/**
 * Where the viewer stands on one board, or null when they are not on it.
 *
 * Rank is "how many are strictly ahead, plus one", which is the same rule the
 * list above uses — so a viewer reading their own rank and then finding
 * themselves in the list sees the same number in both places.
 */
export async function standingFor(
  periodKey: string,
  scopeType: LeaderboardScope,
  scopeId: string | null,
  userId: string,
  executor: Executor = db,
): Promise<Standing | null> {
  const [mine] = await executor
    .select({ score: leaderboardRunningTotals.score })
    .from(leaderboardRunningTotals)
    .where(and(board(periodKey, scopeType, scopeId), eq(leaderboardRunningTotals.userId, userId)))
    .limit(1);

  if (!mine) return null;

  const score = Number(mine.score);
  // Present in the table but not on the board — a net zero or a penalty. The
  // row existing is not the same as being ranked.
  if (score <= 0) return null;

  const [ahead] = await executor
    .select({ value: count() })
    .from(leaderboardRunningTotals)
    .innerJoin(users, eq(users.id, leaderboardRunningTotals.userId))
    .where(
      and(board(periodKey, scopeType, scopeId), visible(), sql`${leaderboardRunningTotals.score} > ${score}`),
    );

  return { rank: Number(ahead?.value ?? 0) + 1, score };
}
