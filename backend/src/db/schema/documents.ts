import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, inet, tsvector } from './custom-types.js';
import {
  copyrightStatusEnum,
  documentStatusEnum,
  documentVisibilityEnum,
  fileKindEnum,
  fileStatusEnum,
  previewStatusEnum,
} from './enums.js';
import { users } from './identity.js';
import { publishedDocument } from './predicates.js';
import {
  academicYears,
  courses,
  documentTypes,
  faculties,
  programs,
  semesters,
  subjects,
} from './taxonomy.js';

/**
 * Documents and object storage.
 *
 * The central security property of this file: a document row never reveals
 * where its bytes live. `storage_objects.object_key` is a randomized uuidv7
 * and the mapper layer strips it from every response, so knowing a document id
 * tells you nothing about the storage layout and enumeration is impossible.
 *
 * The central search property: `search_text` is a plain column maintained by
 * trigger, and `tsv` is a STORED generated column derived from it. This split
 * is necessary — a generated column cannot read other tables, so it cannot
 * itself join in tag names or taxonomy names. The trigger recomputes
 * `search_text` from all of those, and `tsv` regenerates automatically.
 */

/**
 * Content-addressed store, deduplicated across documents.
 *
 * Two documents may legitimately share one physical object — the same blank
 * lab template uploaded by fifty students must be stored once. `ref_count` is
 * what makes it safe to delete the object when the last document referencing
 * it is purged.
 */
export const storageObjects = pgTable(
  'storage_objects',
  {
    /** sha256 of the file bytes. */
    contentHash: bytea('content_hash').primaryKey(),
    bucket: text('bucket').notNull(),
    /** Randomized key. NEVER derived from the original filename. */
    objectKey: text('object_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** MIME detected from magic bytes, not from the client's declaration. */
    detectedMime: text('detected_mime').notNull(),
    refCount: integer('ref_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('storage_objects_object_key_uq').on(t.objectKey),
    index('storage_objects_ref_count_idx').on(t.refCount),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: text('slug'),
    title: text('title').notNull(),
    description: text('description'),

    documentTypeId: uuid('document_type_id')
      .notNull()
      .references(() => documentTypes.id, { onDelete: 'restrict' }),

    visibility: documentVisibilityEnum('visibility').notNull().default('internal'),
    status: documentStatusEnum('status').notNull().default('pending_review'),

    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // --- Academic taxonomy. RESTRICT everywhere: a faculty with documents
    // cannot be hard-deleted, only deactivated, so historical metadata never
    // dangles or silently reassigns.
    facultyId: uuid('faculty_id')
      .notNull()
      .references(() => faculties.id, { onDelete: 'restrict' }),
    programId: uuid('program_id').references(() => programs.id, { onDelete: 'restrict' }),
    subjectId: uuid('subject_id').references(() => subjects.id, { onDelete: 'restrict' }),
    courseId: uuid('course_id').references(() => courses.id, { onDelete: 'restrict' }),
    academicYearId: uuid('academic_year_id').references(() => academicYears.id, {
      onDelete: 'restrict',
    }),
    semesterId: uuid('semester_id').references(() => semesters.id, { onDelete: 'restrict' }),

    /** Denormalised from the primary file so listing pages need no join. */
    fileKind: fileKindEnum('file_kind'),
    language: text('language').notNull().default('vi'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    pageCount: integer('page_count'),

    // --- Denormalised counters. Maintained in the same transaction as the
    // event that changes them, so they never drift from the source tables.
    downloadCount: integer('download_count').notNull().default(0),
    viewCount: integer('view_count').notNull().default(0),
    ratingCount: integer('rating_count').notNull().default(0),
    ratingSum: integer('rating_sum').notNull().default(0),
    ratingAvg: numeric('rating_avg', { precision: 3, scale: 2 }).generatedAlwaysAs(
      sql`CASE WHEN rating_count = 0 THEN NULL ELSE (rating_sum::numeric / rating_count)::numeric(3,2) END`,
    ),
    likeCount: integer('like_count').notNull().default(0),
    commentCount: integer('comment_count').notNull().default(0),

    // --- Copyright / content policy (§28). Columns exist in M1 because they
    // are cheap now and a migration on a large documents table is not.
    license: text('license'),
    copyrightStatus: copyrightStatusEnum('copyright_status').notNull().default('unknown'),
    source: text('source'),
    attribution: text('attribution'),
    /** The uploader asserted they have the right to share this. */
    uploaderConfirmed: boolean('uploader_confirmed').notNull().default(false),

    /**
     * Unaccented search haystack: title + description + tag names + taxonomy
     * names. Maintained by trigger. Kept as a plain column precisely because
     * the trigger needs to write it, which a generated column forbids.
     */
    searchText: text('search_text').notNull().default(''),
    /**
     * Vietnamese full-text vector.
     *
     * `simple` rather than `english`: Postgres has no Vietnamese stemmer, and
     * applying English stemming to Vietnamese produces garbage tokens. `simple`
     * splits on whitespace/punctuation with no stemming, which is the correct
     * behaviour here. `immutable_unaccent` folds diacritics so a query for
     * "cong nghe" matches "Công nghệ".
     */
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', immutable_unaccent(search_text))`,
    ),

    publishedAt: timestamp('published_at', { withTimezone: true }),
    moderatedBy: uuid('moderated_by').references(() => users.id, { onDelete: 'set null' }),
    moderatedAt: timestamp('moderated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // --- Full-text and fuzzy search
    index('documents_tsv_gin_idx').using('gin', t.tsv),
    index('documents_title_trgm_idx').using(
      'gin',
      sql`immutable_unaccent(title) gin_trgm_ops`,
    ),

    // --- Filter + sort indexes. Every predicate below is the shared
    // `publishedDocument` constant, so queries using the same constant are
    // guaranteed to be able to use them.
    index('documents_faculty_idx')
      .on(t.facultyId, t.publishedAt.desc())
      .where(publishedDocument),
    index('documents_program_idx')
      .on(t.programId, t.publishedAt.desc())
      .where(publishedDocument),
    index('documents_subject_idx')
      .on(t.subjectId, t.publishedAt.desc())
      .where(publishedDocument),
    index('documents_year_semester_idx')
      .on(t.academicYearId, t.semesterId, t.publishedAt.desc())
      .where(publishedDocument),
    index('documents_type_kind_idx')
      .on(t.documentTypeId, t.fileKind, t.publishedAt.desc())
      .where(publishedDocument),

    // --- The four supported sort orders, each with its own index.
    index('documents_newest_idx').on(t.publishedAt.desc()).where(publishedDocument),
    index('documents_popular_idx').on(t.downloadCount.desc()).where(publishedDocument),
    index('documents_rated_idx')
      .on(sql`rating_avg DESC NULLS LAST`, t.ratingCount.desc())
      .where(publishedDocument),

    // --- Ownership and moderation queues
    index('documents_owner_idx')
      .on(t.ownerUserId, t.createdAt.desc())
      .where(sql`deleted_at IS NULL`),
    index('documents_moderation_queue_idx')
      .on(t.createdAt)
      .where(sql`deleted_at IS NULL AND status = 'pending_review'`),

    uniqueIndex('documents_slug_uq')
      .on(t.slug)
      .where(sql`slug IS NOT NULL AND deleted_at IS NULL`),
  ],
);

/**
 * A physical file attached to a document. A document may carry several
 * (a report plus its dataset), with exactly one flagged primary.
 */
export const documentFiles = pgTable(
  'document_files',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    contentHash: bytea('content_hash')
      .notNull()
      .references(() => storageObjects.contentHash, { onDelete: 'restrict' }),

    /** Shown to users and set as the download filename. Lives only in the DB. */
    originalName: text('original_name').notNull(),
    /** Derived from the DETECTED mime type, never from the supplied filename. */
    extension: text('extension'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** What the client claimed. Kept for abuse forensics, never trusted. */
    declaredMime: text('declared_mime'),
    /** What the bytes actually are. This is the value that gates everything. */
    detectedMime: text('detected_mime').notNull(),
    fileKind: fileKindEnum('file_kind').notNull(),

    isPrimary: boolean('is_primary').notNull().default(false),
    status: fileStatusEnum('status').notNull().default('pending'),
    pageCount: integer('page_count'),

    // --- Office -> PDF preview artifact, produced by the converter worker.
    previewStatus: previewStatusEnum('preview_status').notNull().default('none'),
    previewContentHash: bytea('preview_content_hash'),
    previewError: text('preview_error'),

    /**
     * Reserved for the antivirus hook (§34/§36). Uploads are gated on
     * `status = 'pending'` until a scan completes; with no scanner wired up in
     * M1 the finalize step sets `ready` directly. When ClamAV lands, this
     * column records the verdict without a schema change.
     */
    scanStatus: text('scan_status').notNull().default('skipped'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('document_files_document_idx').on(t.documentId).where(sql`deleted_at IS NULL`),
    // Exactly one primary file per document.
    uniqueIndex('document_files_primary_uq')
      .on(t.documentId)
      .where(sql`is_primary AND deleted_at IS NULL`),
    index('document_files_content_hash_idx').on(t.contentHash),
    index('document_files_preview_queue_idx')
      .on(t.createdAt)
      .where(sql`preview_status = 'queued'`),
    // Lets the storage dashboard find duplicate and orphaned blobs cheaply.
    index('document_files_orphan_idx').on(t.contentHash).where(sql`deleted_at IS NOT NULL`),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tags_slug_uq').on(t.slug),
    index('tags_usage_idx').on(t.usageCount.desc()),
    index('tags_name_trgm_idx').using('gin', sql`immutable_unaccent(name) gin_trgm_ops`),
  ],
);

export const documentTags = pgTable(
  'document_tags',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.tagId] }),
    index('document_tags_tag_idx').on(t.tagId),
  ],
);

export const documentRatings = pgTable(
  'document_ratings',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 1..5, enforced by a CHECK constraint in the migration. */
    rating: smallint('rating').notNull(),
    review: text('review'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One rating per user per document — updating replaces, never accumulates.
    uniqueIndex('document_ratings_user_doc_uq').on(t.documentId, t.userId),
    index('document_ratings_document_idx').on(t.documentId),
  ],
);

/**
 * Append-only download log. Drives the "most downloaded" ranking and the
 * abuse forensics for bulk-download scraping. Partition monthly once it grows.
 */
export const downloadEvents = pgTable(
  'download_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id').references(() => documentFiles.id, { onDelete: 'set null' }),
    /** NULL for anonymous downloads, when the document allows them. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    referer: text('referer'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('download_events_document_idx').on(t.documentId, t.createdAt.desc()),
    index('download_events_user_idx').on(t.userId, t.createdAt.desc()),
    // Supports "this IP downloaded 400 files in an hour" abuse queries.
    index('download_events_ip_idx').on(t.ip, t.createdAt.desc()),
  ],
);

/** Every status transition a document makes, with who made it and why. */
export const documentModerationEvents = pgTable(
  'document_moderation_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    fromStatus: documentStatusEnum('from_status'),
    toStatus: documentStatusEnum('to_status').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('document_moderation_events_doc_idx').on(t.documentId, t.createdAt.desc())],
);
