ALTER TABLE "leaderboard_running_totals" DROP CONSTRAINT "leaderboard_running_totals_pk";--> statement-breakpoint
ALTER TABLE "leaderboard_running_totals" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "leaderboard_running_totals" ADD CONSTRAINT "leaderboard_running_totals_uq" UNIQUE("period_type","period_key","scope_type","scope_id","user_id");--> statement-breakpoint
-- Hand-added, and it has to be here rather than in the generated lines above.
--
-- A primary key column is implicitly NOT NULL, and dropping the constraint does
-- NOT drop that attribute — so after the DROP above, `scope_id` was still NOT
-- NULL and the university-wide row (`scope_id IS NULL`, the row this table
-- mostly exists for) could not be inserted at all.
--
-- drizzle-kit cannot generate this statement, because its snapshot always
-- described `scope_id` as nullable: the NOT NULL was never in the schema, it
-- was a side effect of the primary key. So the snapshot was right and the
-- database was wrong, and this line is what brings the two back together. It
-- will not be re-emitted by `db:generate`, because there is no diff left.
ALTER TABLE "leaderboard_running_totals" ALTER COLUMN "scope_id" DROP NOT NULL;
