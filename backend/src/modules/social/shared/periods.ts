/**
 * Leaderboard period keys.
 *
 * ONE definition, imported by both the writer (a reputation event updating the
 * running totals) and the reader (the leaderboard page). Two copies of a date
 * format is the classic way a leaderboard comes back empty: the writer stores
 * `'2026-10'`, the reader asks for `'2026-1'`, and the page shows nobody — with
 * no error raised anywhere, because both queries are individually correct.
 *
 * UTC, matching the writer. A local-time key would move bucket boundaries by
 * the server's offset, so the same event would land in a different month
 * depending on where the process happens to run — and Windows Server 2012 R2 in
 * Vietnam and a Linux development box in UTC+7 would disagree at month ends.
 */

export function monthKey(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The month currently in progress. */
export function currentMonthKey(): string {
  return monthKey(new Date());
}

/** True when the string looks like a key `monthKey` could have produced. */
export function isMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
