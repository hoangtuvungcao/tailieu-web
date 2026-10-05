ALTER TYPE "public"."notification_kind" ADD VALUE 'document_comment';--> statement-breakpoint
DROP INDEX "collections_owner_title_uq";--> statement-breakpoint
DROP INDEX "saved_searches_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "collections_owner_title_uq" ON "collections" USING btree ("owner_user_id",lower(immutable_unaccent(title))) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_searches_uq" ON "saved_searches" USING btree ("user_id",lower(immutable_unaccent(label))) WHERE deleted_at IS NULL;