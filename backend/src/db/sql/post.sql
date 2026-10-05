-- =============================================================================
-- POST-MIGRATION BOOTSTRAP
-- =============================================================================
-- Runs after every migration, on every boot. Everything here is idempotent
-- (CREATE OR REPLACE / DROP ... IF EXISTS) so re-running is safe and cheap.
--
-- This file holds the things Drizzle's schema DSL cannot express: trigger
-- functions, cross-table search maintenance, and CHECK constraints.
-- =============================================================================

-- =============================================================================
-- SEARCH TEXT MAINTENANCE
-- =============================================================================
-- `documents.search_text` is the unaccented haystack that `documents.tsv` is
-- generated from. It must contain text that lives in OTHER tables — tag names,
-- faculty names, subject names — and a generated column cannot read other
-- tables. So a trigger maintains the plain column, and the generated tsvector
-- column downstream regenerates automatically whenever it changes.
--
-- All of it is unaccented on the way in so the GIN index over `tsv` and the
-- trigram index over the title agree on what "matching" means.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.compute_document_search_text(p_document_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT concat_ws(
    ' ',
    d.title,
    d.description,
    dt.name,
    -- Taxonomy: both the human name and the code, because students search for
    -- "7480201" and "Công nghệ thông tin" with equal frequency.
    f.name, f.short_name, f.code,
    p.name, p.code,
    s.name, s.code,
    c.name, c.code,
    ay.code,
    -- Tag names could not be reached from a generated column; this subquery is
    -- the reason search_text is trigger-maintained instead.
    (
      SELECT string_agg(t.name, ' ')
      FROM document_tags dtg
      JOIN tags t ON t.id = dtg.tag_id
      WHERE dtg.document_id = d.id
    )
  )
  FROM documents d
  LEFT JOIN document_types dt ON dt.id = d.document_type_id
  LEFT JOIN faculties      f  ON f.id  = d.faculty_id
  LEFT JOIN programs       p  ON p.id  = d.program_id
  LEFT JOIN subjects       s  ON s.id  = d.subject_id
  LEFT JOIN courses        c  ON c.id  = d.course_id
  LEFT JOIN academic_years ay ON ay.id = d.academic_year_id
  WHERE d.id = p_document_id
$$;

COMMENT ON FUNCTION public.compute_document_search_text(uuid) IS
  'Builds the unaccented search haystack for one document, joining taxonomy and tag names that a generated column cannot reach.';

-- Recompute for one document. Used by every trigger below.
CREATE OR REPLACE FUNCTION public.refresh_document_search_text(p_document_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE documents
     SET search_text = coalesce(public.compute_document_search_text(p_document_id), '')
   WHERE id = p_document_id;
END;
$$;

-- --- documents ---------------------------------------------------------------
-- AFTER, not BEFORE: the row must be visible to the SELECT inside
-- compute_document_search_text. A BEFORE trigger on INSERT would query for a
-- row that has not been written yet and compute an empty haystack.
--
-- The column list is deliberately specific. `search_text` is NOT in it, which
-- is what prevents the UPDATE below from re-firing this trigger and recursing.
CREATE OR REPLACE FUNCTION public.trg_documents_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.refresh_document_search_text(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS documents_search_text_trg ON documents;
CREATE TRIGGER documents_search_text_trg
AFTER INSERT OR UPDATE OF
  title, description, document_type_id, faculty_id, program_id, subject_id, course_id, academic_year_id
ON documents
FOR EACH ROW
EXECUTE FUNCTION public.trg_documents_search_text();

-- --- tags attached to a document --------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_document_tags_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_document_id uuid;
BEGIN
  -- A DELETE has no NEW row; an INSERT has no OLD row.
  v_document_id := COALESCE(NEW.document_id, OLD.document_id);
  PERFORM public.refresh_document_search_text(v_document_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS document_tags_search_text_trg ON document_tags;
CREATE TRIGGER document_tags_search_text_trg
AFTER INSERT OR DELETE OR UPDATE ON document_tags
FOR EACH ROW
EXECUTE FUNCTION public.trg_document_tags_search_text();

-- --- a tag is renamed --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_tags_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM public.refresh_document_search_text(d.id)
    FROM documents d
    JOIN document_tags dtg ON dtg.document_id = d.id
    WHERE dtg.tag_id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS tags_search_text_trg ON tags;
CREATE TRIGGER tags_search_text_trg
AFTER UPDATE ON tags
FOR EACH ROW
EXECUTE FUNCTION public.trg_tags_search_text();

-- --- taxonomy renamed --------------------------------------------------------
-- Renaming a faculty or subject must make existing documents findable under the
-- new name. These are rare administrator actions, so the cost of rewriting the
-- affected documents is acceptable; correctness matters more than write speed.
CREATE OR REPLACE FUNCTION public.trg_taxonomy_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_name_changed boolean;
BEGIN
  v_name_changed := (to_jsonb(NEW) -> 'name') IS DISTINCT FROM (to_jsonb(OLD) -> 'name')
                 OR (to_jsonb(NEW) -> 'short_name') IS DISTINCT FROM (to_jsonb(OLD) -> 'short_name');

  IF NOT v_name_changed THEN
    RETURN NULL;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'faculties'      THEN PERFORM public.refresh_document_search_text(id) FROM documents WHERE faculty_id      = NEW.id;
    WHEN 'programs'       THEN PERFORM public.refresh_document_search_text(id) FROM documents WHERE program_id      = NEW.id;
    WHEN 'subjects'       THEN PERFORM public.refresh_document_search_text(id) FROM documents WHERE subject_id      = NEW.id;
    WHEN 'courses'        THEN PERFORM public.refresh_document_search_text(id) FROM documents WHERE course_id       = NEW.id;
    WHEN 'document_types' THEN PERFORM public.refresh_document_search_text(id) FROM documents WHERE document_type_id = NEW.id;
    ELSE NULL;
  END CASE;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS faculties_search_text_trg ON faculties;
CREATE TRIGGER faculties_search_text_trg
AFTER UPDATE ON faculties FOR EACH ROW
EXECUTE FUNCTION public.trg_taxonomy_search_text();

DROP TRIGGER IF EXISTS programs_search_text_trg ON programs;
CREATE TRIGGER programs_search_text_trg
AFTER UPDATE ON programs FOR EACH ROW
EXECUTE FUNCTION public.trg_taxonomy_search_text();

DROP TRIGGER IF EXISTS subjects_search_text_trg ON subjects;
CREATE TRIGGER subjects_search_text_trg
AFTER UPDATE ON subjects FOR EACH ROW
EXECUTE FUNCTION public.trg_taxonomy_search_text();

DROP TRIGGER IF EXISTS courses_search_text_trg ON courses;
CREATE TRIGGER courses_search_text_trg
AFTER UPDATE ON courses FOR EACH ROW
EXECUTE FUNCTION public.trg_taxonomy_search_text();

DROP TRIGGER IF EXISTS document_types_search_text_trg ON document_types;
CREATE TRIGGER document_types_search_text_trg
AFTER UPDATE ON document_types FOR EACH ROW
EXECUTE FUNCTION public.trg_taxonomy_search_text();

-- --- backfill ----------------------------------------------------------------
-- Recompute any document whose haystack is empty or stale. Covers rows written
-- before this trigger existed, and any that slipped through during a restore.
UPDATE documents
   SET search_text = coalesce(public.compute_document_search_text(id), '')
 WHERE search_text = '';

-- =============================================================================
-- updated_at TRIGGERS
-- =============================================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'auth_identities', 'student_verifications',
    'roles', 'faculties', 'programs', 'academic_years', 'semesters',
    'subjects', 'courses', 'document_types',
    'documents', 'document_ratings', 'upload_sessions', 'storage_usage'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_set_updated_at_trg', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t || '_set_updated_at_trg', t
    );
  END LOOP;
END;
$$;

-- =============================================================================
-- CHECK CONSTRAINTS
-- =============================================================================
-- Business rules that must hold even if a future code path, a manual psql
-- session, or a restore script forgets them.

ALTER TABLE document_ratings DROP CONSTRAINT IF EXISTS document_ratings_rating_range_chk;
ALTER TABLE document_ratings
  ADD CONSTRAINT document_ratings_rating_range_chk CHECK (rating BETWEEN 1 AND 5);

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_counters_nonneg_chk;
ALTER TABLE documents
  ADD CONSTRAINT documents_counters_nonneg_chk
  CHECK (
    download_count >= 0 AND view_count >= 0 AND like_count >= 0 AND comment_count >= 0
    AND rating_count >= 0 AND rating_sum >= 0
  );

-- A rating average can only be produced from consistent inputs. This catches
-- an out-of-band UPDATE that bumps one counter without the other.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_rating_sum_chk;
ALTER TABLE documents
  ADD CONSTRAINT documents_rating_sum_chk
  CHECK (rating_count = 0 OR rating_sum BETWEEN rating_count AND rating_count * 5);

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_published_has_timestamp_chk;
ALTER TABLE documents
  ADD CONSTRAINT documents_published_has_timestamp_chk
  CHECK (status <> 'published' OR published_at IS NOT NULL);

ALTER TABLE storage_objects DROP CONSTRAINT IF EXISTS storage_objects_size_chk;
ALTER TABLE storage_objects
  ADD CONSTRAINT storage_objects_size_chk CHECK (size_bytes >= 0 AND ref_count >= 0);

ALTER TABLE document_files DROP CONSTRAINT IF EXISTS document_files_size_chk;
ALTER TABLE document_files
  ADD CONSTRAINT document_files_size_chk CHECK (size_bytes >= 0);

ALTER TABLE upload_chunks DROP CONSTRAINT IF EXISTS upload_chunks_index_chk;
ALTER TABLE upload_chunks
  ADD CONSTRAINT upload_chunks_index_chk CHECK (chunk_index >= 0 AND size_bytes > 0);

ALTER TABLE upload_sessions DROP CONSTRAINT IF EXISTS upload_sessions_shape_chk;
ALTER TABLE upload_sessions
  ADD CONSTRAINT upload_sessions_shape_chk
  CHECK (total_size > 0 AND chunk_size > 0 AND total_chunks > 0 AND received_chunks >= 0);

-- A slug must be URL-safe; catching it here stops a crafted title from
-- producing a link that breaks routing.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_slug_format_chk;
ALTER TABLE documents
  ADD CONSTRAINT documents_slug_format_chk
  CHECK (slug IS NULL OR slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

-- =============================================================================
-- SOCIAL CONSTRAINTS
-- =============================================================================
-- Rules that must hold even if a future code path forgets them. Each one
-- encodes something that would otherwise be a silent correctness problem
-- rather than an error.

-- Unbounded reply nesting is a UI problem (nothing renders sensibly past four
-- levels) AND a query problem (a deep tree cannot be fetched in one flat scan).
-- The cap is enforced here so it cannot be exceeded by any code path.
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_depth_chk;
ALTER TABLE comments
  ADD CONSTRAINT comments_depth_chk CHECK (depth >= 0 AND depth <= 3);

-- A reply has a parent and a depth > 0; a top-level comment has neither. The
-- two must agree, or a recursive tree walk finds orphans.
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_parent_depth_chk;
ALTER TABLE comments
  ADD CONSTRAINT comments_parent_depth_chk
  CHECK ((parent_comment_id IS NULL) = (depth = 0));

-- Following yourself is meaningless and would put your own posts in your
-- "following" feed twice.
ALTER TABLE follows DROP CONSTRAINT IF EXISTS follows_not_self_chk;
ALTER TABLE follows
  ADD CONSTRAINT follows_not_self_chk CHECK (follower_user_id <> followee_user_id);

-- Liking your own content must not generate a notification about yourself.
-- (The reputation system separately awards zero for self-engagement; this stops
-- the notification, which would be pure noise.)
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_not_self_chk;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_not_self_chk
  CHECK (actor_user_id IS NULL OR actor_user_id <> recipient_user_id);

-- Counters must not go negative. A double-decrement — a like removed twice, or
-- a decrement that raced an increment — otherwise silently produces a post with
-- -1 likes, which is worse than an error because nothing surfaces it.
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_counters_chk;
ALTER TABLE posts
  ADD CONSTRAINT posts_counters_chk
  CHECK (like_count >= 0 AND comment_count >= 0 AND bookmark_count >= 0 AND hot_score >= 0);

ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_counters_chk;
ALTER TABLE comments
  ADD CONSTRAINT comments_counters_chk
  CHECK (like_count >= 0 AND reply_count >= 0);

ALTER TABLE collections DROP CONSTRAINT IF EXISTS collections_counters_chk;
ALTER TABLE collections
  ADD CONSTRAINT collections_counters_chk
  CHECK (item_count >= 0 AND follower_count >= 0);

-- The unread badge is a count of notifications. A negative value would make the
-- header show "-3" and never recover, since it only decrements on mark-read.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_unread_nonneg_chk;
ALTER TABLE users
  ADD CONSTRAINT users_unread_nonneg_chk CHECK (unread_notification_count >= 0);

-- A notification with no target and no payload is unrenderable.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_renderable_chk;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_renderable_chk
  CHECK (target_id IS NOT NULL OR kind = 'system');

-- Awarding reputation to yourself is the simplest possible abuse.
ALTER TABLE reputation_events DROP CONSTRAINT IF EXISTS reputation_not_self_chk;
ALTER TABLE reputation_events
  ADD CONSTRAINT reputation_not_self_chk
  CHECK (actor_user_id IS NULL OR actor_user_id <> user_id);

-- =============================================================================
-- VIETNAMESE-SAFE CASE FOLDING FOR UNIQUE INDEXES
-- =============================================================================
-- The database is created with LC_COLLATE=C (see deploy instructions), and
-- under that collation Postgres `lower()` and the `citext` type fold only
-- ASCII. Measured on this cluster:
--
--     SELECT lower('Ôn thi'), lower('ôn thi');
--     -- 'Ôn thi' | 'ôn thi'          <- and lower(a) = lower(b) is FALSE
--
-- So a unique index declared as `lower(title)` — which reads as "these are the
-- same title" — silently permits both spellings. The constraint that was
-- supposed to stop it does not, and nothing reports the difference: two
-- near-identical collections simply coexist.
--
-- `immutable_unaccent` folds diacritics the way the rest of the platform
-- already does for search, so `lower(immutable_unaccent(x))` is the comparison
-- that actually means "the same title". It is the same function behind the
-- search indexes, which keeps "what the user typed" and "what counts as a
-- duplicate" consistent.
--
-- The fold is deliberate and slightly aggressive: "Ôn thi" and "On thi" now
-- collide. That is the right trade for a title check on a Vietnamese-language
-- platform, where the unaccented form is what people type — and it is what the
-- service-side pre-check compares with, so the two agree exactly.

-- The identical defect appears in `saved_searches_uq`, found while fixing the
-- one above. Nothing writes to that table yet, so it is latent rather than
-- broken in production — which is exactly why it was worth correcting while
-- "no data depends on the old behaviour" was still true.
--
-- Both definitions live in the Drizzle schema (`db/schema/social/engagement.ts`)
-- and reach the database through the generated migrations. They are deliberately
-- NOT restated here. A second copy of a schema object in this file is a
-- definition no migration knows about, and the two drift apart silently — which
-- is precisely the failure the section above describes. This file is for what
-- the schema DSL cannot express: triggers, functions and CHECK constraints. An
-- index is not one of those.
