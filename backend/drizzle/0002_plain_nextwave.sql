CREATE TYPE "public"."comment_target" AS ENUM('document', 'post');--> statement-breakpoint
CREATE TYPE "public"."leaderboard_period" AS ENUM('monthly', 'semester', 'yearly', 'all_time');--> statement-breakpoint
CREATE TYPE "public"."leaderboard_scope" AS ENUM('university', 'faculty', 'program');--> statement-breakpoint
CREATE TYPE "public"."moderation_state" AS ENUM('visible', 'hidden', 'removed');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('post_like', 'comment_like', 'post_comment', 'comment_reply', 'follow', 'document_like', 'rating_received', 'badge_awarded', 'collection_share', 'moderation', 'system');--> statement-breakpoint
CREATE TYPE "public"."post_kind" AS ENUM('status', 'link', 'doc_share');--> statement-breakpoint
CREATE TYPE "public"."reaction" AS ENUM('like', 'insightful');--> statement-breakpoint
CREATE TYPE "public"."reputation_reason" AS ENUM('document_published', 'like_received', 'comment_like_received', 'rating_received', 'moderation_penalty', 'spam_penalty', 'manual_adjust');--> statement-breakpoint
CREATE TYPE "public"."social_target" AS ENUM('document', 'post', 'comment', 'user', 'collection', 'faculty', 'program', 'subject', 'tag');--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "comment_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"parent_comment_id" uuid,
	"root_comment_id" uuid,
	"depth" smallint DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"moderation_state" "moderation_state" DEFAULT 'visible' NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "post_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"url" text NOT NULL,
	"media_kind" "citext" DEFAULT 'link' NOT NULL,
	"position" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_tags" (
	"post_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" uuid NOT NULL,
	"title" text,
	"body" text NOT NULL,
	"post_kind" "post_kind" DEFAULT 'status' NOT NULL,
	"visibility" "document_visibility" DEFAULT 'internal' NOT NULL,
	"faculty_id" uuid,
	"program_id" uuid,
	"subject_id" uuid,
	"link_url" text,
	"shared_document_id" uuid,
	"like_count" integer DEFAULT 0 NOT NULL,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"bookmark_count" integer DEFAULT 0 NOT NULL,
	"hot_score" double precision DEFAULT 0 NOT NULL,
	"moderation_state" "moderation_state" DEFAULT 'visible' NOT NULL,
	"edited_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"search_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" "social_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"folder" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "collection_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"target_type" "social_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"added_by_user_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"visibility" "document_visibility" DEFAULT 'private' NOT NULL,
	"cover_document_id" uuid,
	"item_count" integer DEFAULT 0 NOT NULL,
	"follower_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "comment_likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reaction" "reaction" DEFAULT 'like' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"comment_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reaction" "reaction" DEFAULT 'like' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"document_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reaction" "reaction" DEFAULT 'like' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"post_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"label" text NOT NULL,
	"query_string" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" "citext" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"tier" smallint DEFAULT 1 NOT NULL,
	"category" text DEFAULT 'general' NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"follower_user_id" uuid NOT NULL,
	"followee_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leaderboard_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"score" numeric(12, 2) NOT NULL,
	"breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_running_totals" (
	"period_type" "leaderboard_period" NOT NULL,
	"period_key" text NOT NULL,
	"scope_type" "leaderboard_scope" NOT NULL,
	"scope_id" uuid,
	"user_id" uuid NOT NULL,
	"score" numeric(12, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leaderboard_running_totals_pk" PRIMARY KEY("period_type","period_key","scope_type","scope_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "leaderboard_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" "leaderboard_scope" NOT NULL,
	"scope_id" uuid,
	"period_type" "leaderboard_period" NOT NULL,
	"period_key" text NOT NULL,
	"metric" text DEFAULT 'reputation' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	CONSTRAINT "leaderboard_snapshots_uq" UNIQUE("scope_type","scope_id","period_type","period_key","metric")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"target_type" "social_target",
	"target_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"group_key" text NOT NULL,
	"aggregation_count" integer DEFAULT 1 NOT NULL,
	"seen_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "reputation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" "reputation_reason" NOT NULL,
	"source_type" "social_target",
	"source_id" uuid,
	"actor_user_id" uuid,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"target_type" "social_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"badge_id" uuid NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"award_reason" text,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "unread_notification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_media" ADD CONSTRAINT "post_media_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_faculty_id_faculties_id_fk" FOREIGN KEY ("faculty_id") REFERENCES "public"."faculties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_shared_document_id_documents_id_fk" FOREIGN KEY ("shared_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_cover_document_id_documents_id_fk" FOREIGN KEY ("cover_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_likes" ADD CONSTRAINT "document_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_likes" ADD CONSTRAINT "document_likes_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_follower_user_id_users_id_fk" FOREIGN KEY ("follower_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_followee_user_id_users_id_fk" FOREIGN KEY ("followee_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_snapshot_id_leaderboard_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."leaderboard_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leaderboard_running_totals" ADD CONSTRAINT "leaderboard_running_totals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_badge_id_badges_id_fk" FOREIGN KEY ("badge_id") REFERENCES "public"."badges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_thread_idx" ON "comments" USING btree ("target_type","target_id","root_comment_id","created_at","id") WHERE deleted_at IS NULL AND moderation_state = 'visible';--> statement-breakpoint
CREATE INDEX "comments_replies_idx" ON "comments" USING btree ("parent_comment_id","created_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "comments_author_idx" ON "comments" USING btree ("author_user_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "post_media_post_idx" ON "post_media" USING btree ("post_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "post_tags_uq" ON "post_tags" USING btree ("post_id","tag_id");--> statement-breakpoint
CREATE INDEX "post_tags_tag_idx" ON "post_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "posts_recent_idx" ON "posts" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE deleted_at IS NULL AND moderation_state = 'visible';--> statement-breakpoint
CREATE INDEX "posts_author_recent_idx" ON "posts" USING btree ("author_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE deleted_at IS NULL AND moderation_state = 'visible';--> statement-breakpoint
CREATE INDEX "posts_faculty_recent_idx" ON "posts" USING btree ("faculty_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE deleted_at IS NULL AND moderation_state = 'visible';--> statement-breakpoint
CREATE INDEX "posts_popular_idx" ON "posts" USING btree ("hot_score" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE deleted_at IS NULL AND moderation_state = 'visible';--> statement-breakpoint
CREATE INDEX "posts_moderation_idx" ON "posts" USING btree ("created_at") WHERE moderation_state <> 'visible' AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_uq" ON "bookmarks" USING btree ("user_id","target_type","target_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "bookmarks_user_idx" ON "bookmarks" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "bookmarks_folder_idx" ON "bookmarks" USING btree ("user_id","folder") WHERE deleted_at IS NULL AND folder IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "collection_items_uq" ON "collection_items" USING btree ("collection_id","target_type","target_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "collection_items_order_idx" ON "collection_items" USING btree ("collection_id","position") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "collections_owner_title_uq" ON "collections" USING btree ("owner_user_id",lower(title)) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "collections_owner_idx" ON "collections" USING btree ("owner_user_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "collections_public_idx" ON "collections" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE deleted_at IS NULL AND visibility = 'public';--> statement-breakpoint
CREATE UNIQUE INDEX "comment_likes_uq" ON "comment_likes" USING btree ("user_id","comment_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "comment_likes_target_idx" ON "comment_likes" USING btree ("comment_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_likes_uq" ON "document_likes" USING btree ("user_id","document_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "document_likes_target_idx" ON "document_likes" USING btree ("document_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "document_likes_user_idx" ON "document_likes" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "post_likes_uq" ON "post_likes" USING btree ("user_id","post_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "post_likes_target_idx" ON "post_likes" USING btree ("post_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "post_likes_user_idx" ON "post_likes" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_searches_uq" ON "saved_searches" USING btree ("user_id",lower(label)) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "badges_code_uq" ON "badges" USING btree ("code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "follows_uq" ON "follows" USING btree ("follower_user_id","followee_user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "follows_following_idx" ON "follows" USING btree ("follower_user_id","followee_user_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "follows_followers_idx" ON "follows" USING btree ("followee_user_id","created_at" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_entries_user_uq" ON "leaderboard_entries" USING btree ("snapshot_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leaderboard_entries_rank_uq" ON "leaderboard_entries" USING btree ("snapshot_id","rank");--> statement-breakpoint
CREATE INDEX "leaderboard_running_totals_top_idx" ON "leaderboard_running_totals" USING btree ("period_type","period_key","scope_type","scope_id","score" DESC NULLS LAST,"user_id");--> statement-breakpoint
CREATE INDEX "notifications_list_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_group_uq" ON "notifications" USING btree ("recipient_user_id","group_key") WHERE read_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("recipient_user_id") WHERE read_at IS NULL AND deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "reputation_events_dedupe_uq" ON "reputation_events" USING btree ("dedupe_key") WHERE dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reputation_events_user_idx" ON "reputation_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reputation_events_time_idx" ON "reputation_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_uq" ON "subscriptions" USING btree ("user_id","target_type","target_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id","target_type") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_badges_uq" ON "user_badges" USING btree ("user_id","badge_id") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "user_badges_user_idx" ON "user_badges" USING btree ("user_id");