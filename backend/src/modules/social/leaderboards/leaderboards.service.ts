import { AppError } from '../../../lib/errors.js';
import type { SocialActor } from '../shared/actor.js';
import { currentMonthKey } from '../shared/periods.js';
import type { LeaderboardScope } from './leaderboards.repository.js';
import * as repo from './leaderboards.repository.js';

/**
 * Leaderboards.
 *
 * Monthly only. Semester and yearly boards would need their own period keys,
 * and `period_key` is free text precisely so they can be added without a
 * migration — but a semester key has to come from the taxonomy (the semester's
 * id), and nothing maintains those running totals yet. Offering the parameter
 * before the rows exist would be a control that only ever returns nothing.
 *
 * There is no all-time board either, and that is deliberate rather than
 * unfinished: an all-time total is `sum(delta)` over every event a user has
 * ever caused, which is the query this whole table exists to avoid. Adding one
 * means maintaining another running total, not reading the existing rows.
 */

export interface LeaderboardEntryDto {
  rank: number;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  score: number;
  isViewer: boolean;
}

export interface LeaderboardDto {
  periodKey: string;
  scope: LeaderboardScope;
  scopeId: string | null;
  entries: LeaderboardEntryDto[];
  /**
   * The viewer's own standing, which may be outside the returned page — or null
   * when they are not on the board at all. Showing "you are 412th" to somebody
   * who has never earned a point would be worse than showing nothing.
   */
  viewer: { rank: number; score: number } | null;
}

export async function getLeaderboard(
  input: {
    period?: string;
    scope: LeaderboardScope;
    scopeId: string | null;
    limit: number;
  },
  actor: SocialActor | null,
): Promise<LeaderboardDto> {
  const periodKey = input.period ?? currentMonthKey();

  // The university board is the one with no scope id. Accepting an id for it
  // would silently query a scope that nothing writes, and return an empty board
  // that looks correct.
  if (input.scope === 'university' && input.scopeId !== null) {
    throw new AppError('BAD_REQUEST', 'Bảng toàn trường không nhận scopeId.');
  }
  if (input.scope !== 'university' && input.scopeId === null) {
    throw new AppError('BAD_REQUEST', 'Bảng theo khoa hoặc ngành cần scopeId.');
  }

  const [rows, viewer] = await Promise.all([
    repo.topFor(periodKey, input.scope, input.scopeId, input.limit),
    actor
      ? repo.standingFor(periodKey, input.scope, input.scopeId, actor.userId)
      : Promise.resolve(null),
  ]);

  return {
    periodKey,
    scope: input.scope,
    scopeId: input.scopeId,
    entries: rows.map((row, index) => ({
      rank: index + 1,
      userId: row.userId,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      score: row.score,
      isViewer: actor?.userId === row.userId,
    })),
    viewer,
  };
}
