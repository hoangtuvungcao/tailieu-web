import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';

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
      score: sql<number>`sum(${leaderboardRunningTotals.score})::float`,
    })
    .from(leaderboardRunningTotals)
    .innerJoin(users, eq(users.id, leaderboardRunningTotals.userId))
    .where(and(board(periodKey, scopeType, scopeId), isNull(users.anonymizedAt)))
    .groupBy(leaderboardRunningTotals.userId, users.displayName, users.avatarUrl)
    .having(sql`sum(${leaderboardRunningTotals.score}) > 0`)
    .orderBy(desc(sql`sum(${leaderboardRunningTotals.score})`), leaderboardRunningTotals.userId)
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
    .select({ score: sql<number>`sum(${leaderboardRunningTotals.score})::float` })
    .from(leaderboardRunningTotals)
    .where(and(board(periodKey, scopeType, scopeId), eq(leaderboardRunningTotals.userId, userId)))
    .groupBy(leaderboardRunningTotals.userId);

  if (!mine || mine.score == null) return null;

  const score = Number(mine.score);
  // Present in the table but not on the board — a net zero or a penalty. The
  // row existing is not the same as being ranked.
  if (score <= 0) return null;

  const [ahead] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(
      executor
        .select({
          userId: leaderboardRunningTotals.userId,
        })
        .from(leaderboardRunningTotals)
        .innerJoin(users, eq(users.id, leaderboardRunningTotals.userId))
        .where(and(board(periodKey, scopeType, scopeId), isNull(users.anonymizedAt)))
        .groupBy(leaderboardRunningTotals.userId)
        .having(sql`sum(${leaderboardRunningTotals.score}) > ${score}`)
        .as('ahead_users'),
    );

  return { rank: Number(ahead?.value ?? 0) + 1, score };
}

/**
 * Self-healing maintenance on startup:
 * 1. Consolidates duplicate rows by user/scope/period if any exist.
 * 2. Enforces unique constraint/index with NULLS NOT DISTINCT in PostgreSQL.
 */
export async function ensureLeaderboardConstraints(): Promise<void> {
  try {
    await db.execute(sql`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables WHERE table_name = 'leaderboard_running_totals'
        ) THEN
          CREATE TEMP TABLE IF NOT EXISTS _tmp_leaderboard_dedup AS
          SELECT
            min(id) as keep_id,
            period_type,
            period_key,
            scope_type,
            scope_id,
            user_id,
            sum(score) as total_score,
            max(updated_at) as latest_updated_at
          FROM leaderboard_running_totals
          GROUP BY period_type, period_key, scope_type, scope_id, user_id;

          UPDATE leaderboard_running_totals l
          SET score = t.total_score, updated_at = t.latest_updated_at
          FROM _tmp_leaderboard_dedup t
          WHERE l.id = t.keep_id;

          DELETE FROM leaderboard_running_totals l
          WHERE NOT EXISTS (
            SELECT 1 FROM _tmp_leaderboard_dedup t WHERE t.keep_id = l.id
          );

          DROP TABLE IF EXISTS _tmp_leaderboard_dedup;

          ALTER TABLE leaderboard_running_totals DROP CONSTRAINT IF EXISTS leaderboard_running_totals_uq;
          DROP INDEX IF EXISTS leaderboard_running_totals_uq;

          CREATE UNIQUE INDEX IF NOT EXISTS leaderboard_running_totals_uq
            ON leaderboard_running_totals (period_type, period_key, scope_type, scope_id, user_id)
            NULLS NOT DISTINCT;
        END IF;
      END $$;
    `);
  } catch (err) {
    console.warn('[leaderboards] ensureLeaderboardConstraints warning:', err);
  }
}
