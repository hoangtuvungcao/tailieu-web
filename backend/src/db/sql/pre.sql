-- =============================================================================
-- PRE-MIGRATION BOOTSTRAP
-- =============================================================================
-- Runs before any generated migration. Everything here is idempotent and has
-- no dependency on application tables, because on a fresh database nothing
-- exists yet.
--
-- Order matters: the generated migrations create GIN and trigram indexes that
-- require these extensions, so this must run first.
-- =============================================================================

-- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Case-insensitive email and slug columns.
CREATE EXTENSION IF NOT EXISTS citext;

-- Diacritic folding. Essential for Vietnamese: without it, a search for
-- "cong nghe" never matches "công nghệ".
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Trigram indexes for partial-word and typo-tolerant matching. This is what
-- actually rescues search quality, because Postgres has no Vietnamese stemmer
-- and the tsvector path alone only matches whole tokens.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- -----------------------------------------------------------------------------
-- immutable_unaccent
-- -----------------------------------------------------------------------------
-- `unaccent()` is marked STABLE, not IMMUTABLE, because its dictionary is a
-- mutable database object. Postgres therefore refuses to use it in a generated
-- column or an expression index — both of which require immutable expressions.
--
-- This wrapper is the standard workaround: it pins the dictionary by name and
-- asserts immutability. The assertion is safe as long as the unaccent
-- dictionary is never edited at runtime, which is true here.
--
-- The explicit 'public.unaccent' argument and schema qualification are both
-- required — without them the function breaks under a non-default search_path,
-- which is exactly what happens inside a SECURITY DEFINER context or a
-- connection that sets search_path.
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$;

COMMENT ON FUNCTION public.immutable_unaccent(text) IS
  'Immutable wrapper around unaccent() so it can be used in generated columns and expression indexes. Assumes the unaccent dictionary is never modified at runtime.';

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
-- One shared trigger function, attached per table in post.sql. Keeping
-- `updated_at` correct in the database rather than in application code means a
-- manual psql fix or a future background job cannot forget to set it.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
