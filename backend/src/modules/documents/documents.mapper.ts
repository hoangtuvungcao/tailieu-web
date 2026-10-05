/**
 * Document DTO mapping.
 *
 * This file is a security boundary, not a formatting convenience.
 *
 * A document row joins to `storage_objects`, which holds `bucket` and
 * `object_key`. Those two values are the only thing standing between a user and
 * every file on the platform: with a key, an attacker who also has any means of
 * reaching the storage endpoint can fetch the object directly, bypassing every
 * authorization check in this application. Bucket listing is denied at the
 * storage layer, but a leaked key is a leaked file.
 *
 * So the rule is: rows are never returned from a controller. Every document
 * reaches the client through `toDocumentDto`, which constructs a new object
 * with an explicit field list. Adding a column to the schema therefore cannot
 * leak it — a new field appears in API responses only when someone writes it
 * here deliberately.
 *
 * `content_hash` is omitted for a second reason: it is the dedup key, so
 * exposing it would let a user confirm whether a file they already have is on
 * the platform, and correlate uploads across accounts.
 */

import type { FileKind } from '../../lib/files/mime.js';

/** Storage-side fields that must never cross this boundary. */
const FORBIDDEN_FIELDS = ['objectKey', 'storageKey', 'bucket', 'contentHash', 'stagingKey'] as const;

export interface DocumentFileDto {
  id: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  fileKind: FileKind;
  isPrimary: boolean;
  status: 'pending' | 'ready' | 'failed';
  extension: string | null;
  pageCount: number | null;
  previewStatus: 'none' | 'queued' | 'processing' | 'ready' | 'failed' | 'unsupported';
  /** Where the file can be downloaded. Never the storage location itself. */
  downloadUrl: string;
}

export interface DocumentDto {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  status: 'draft' | 'pending_review' | 'published' | 'rejected' | 'archived';
  visibility: 'public' | 'internal' | 'private';
  language: string;

  fileKind: FileKind | null;
  sizeBytes: number | null;
  pageCount: number | null;

  owner: { id: string; displayName: string; avatarUrl: string | null } | null;

  taxonomy: {
    faculty: { id: string; name: string; code: string } | null;
    program: { id: string; name: string; code: string } | null;
    subject: { id: string; name: string; code: string } | null;
    course: { id: string; name: string | null; code: string } | null;
    documentType: { id: string; name: string; code: string } | null;
    academicYear: { id: string; code: string; name: string } | null;
    semester: { id: string; code: string; name: string } | null;
  };

  tags: { id: string; slug: string; name: string }[];
  files: DocumentFileDto[];

  stats: {
    downloads: number;
    views: number;
    likes: number;
    comments: number;
    ratingCount: number;
    ratingAverage: number | null;
  };

  copyright: {
    license: string | null;
    status: string;
    source: string | null;
    attribution: string | null;
  };

  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;

  /** Present only when the caller may act on the document. */
  permissions?: {
    canEdit: boolean;
    canDelete: boolean;
    canModerate: boolean;
    canDownload: boolean;
  };
}

/** Shape returned by the repository's document query. */
export interface DocumentRow {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  status: DocumentDto['status'];
  visibility: DocumentDto['visibility'];
  language: string;
  fileKind: FileKind | null;
  sizeBytes: number | null;
  pageCount: number | null;
  downloadCount: number;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  ratingCount: number;
  ratingSum: number;
  ratingAvg: string | number | null;
  license: string | null;
  copyrightStatus: string;
  source: string | null;
  attribution: string | null;
  publishedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  ownerUserId: string;
  ownerDisplayName: string | null;
  ownerAvatarUrl: string | null;
  facultyId: string | null;
  facultyName: string | null;
  facultyCode: string | null;
  programId: string | null;
  programName: string | null;
  programCode: string | null;
  subjectId: string | null;
  subjectName: string | null;
  subjectCode: string | null;
  courseId: string | null;
  courseName: string | null;
  courseCode: string | null;
  documentTypeId: string | null;
  documentTypeName: string | null;
  documentTypeCode: string | null;
  academicYearId: string | null;
  academicYearCode: string | null;
  academicYearName: string | null;
  semesterId: string | null;
  semesterCode: string | null;
  semesterName: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Build a taxonomy reference.
 *
 * `code` is always a string (empty when the source column is null) so the DTO
 * shape is stable — a client should never have to distinguish "no code" from
 * "code is undefined". `name` is allowed to be null only for courses, which is
 * why there are two helpers rather than one with an optional parameter: an
 * optional parameter makes the return type ambiguous and every call site has
 * to narrow it.
 */
function ref(
  id: string | null,
  name: string | null,
  code: string | null,
): { id: string; name: string; code: string } | null {
  if (!id) return null;
  return { id, name: name ?? '', code: code ?? '' };
}

function courseRef(
  id: string | null,
  name: string | null,
  code: string | null,
): { id: string; name: string | null; code: string } | null {
  if (!id) return null;
  return { id, name, code: code ?? '' };
}

export interface ToDocumentDtoOptions {
  files?: {
    id: string;
    originalName: string;
    sizeBytes: number;
    detectedMime: string;
    fileKind: FileKind;
    isPrimary: boolean;
    status: 'pending' | 'ready' | 'failed';
    extension: string | null;
    pageCount: number | null;
    previewStatus: DocumentDto['files'][number]['previewStatus'];
  }[];
  tags?: { id: string; slug: string; name: string }[];
  permissions?: DocumentDto['permissions'];
}

export function toDocumentDto(
  row: DocumentRow,
  options: ToDocumentDtoOptions = {},
): DocumentDto {
  // `ratingAvg` is a Postgres NUMERIC, which pg returns as a string to avoid
  // float precision loss. Converted explicitly here so the API returns a number
  // — a client doing `rating > 4` on "4.50" gets a string comparison otherwise.
  const ratingAverage =
    row.ratingAvg === null || row.ratingAvg === undefined ? null : Number(row.ratingAvg);

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    visibility: row.visibility,
    language: row.language,

    fileKind: row.fileKind,
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    pageCount: row.pageCount,

    owner: row.ownerUserId
      ? {
          id: row.ownerUserId,
          displayName: row.ownerDisplayName ?? 'Người dùng ẩn danh',
          avatarUrl: row.ownerAvatarUrl,
        }
      : null,

    taxonomy: {
      faculty: ref(row.facultyId, row.facultyName, row.facultyCode),
      program: ref(row.programId, row.programName, row.programCode),
      subject: ref(row.subjectId, row.subjectName, row.subjectCode),
      course: courseRef(row.courseId, row.courseName, row.courseCode),
      documentType: ref(row.documentTypeId, row.documentTypeName, row.documentTypeCode),
      academicYear: ref(row.academicYearId, row.academicYearName, row.academicYearCode),
      semester: ref(row.semesterId, row.semesterName, row.semesterCode),
    },

    tags: options.tags ?? [],
    files: (options.files ?? []).map((file) => ({
      id: file.id,
      originalName: file.originalName,
      sizeBytes: Number(file.sizeBytes),
      mimeType: file.detectedMime,
      fileKind: file.fileKind,
      isPrimary: file.isPrimary,
      status: file.status,
      extension: file.extension,
      pageCount: file.pageCount,
      previewStatus: file.previewStatus,
      // A route, not a location. The signed URL is minted per request, after an
      // authorization check, and expires in ~2 minutes.
      downloadUrl: `/api/v1/documents/${row.id}/download?fileId=${file.id}`,
    })),

    stats: {
      downloads: Number(row.downloadCount),
      views: Number(row.viewCount),
      likes: Number(row.likeCount),
      comments: Number(row.commentCount),
      ratingCount: Number(row.ratingCount),
      ratingAverage,
    },

    copyright: {
      license: row.license,
      status: row.copyrightStatus,
      source: row.source,
      attribution: row.attribution,
    },

    publishedAt: iso(row.publishedAt),
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,

    ...(options.permissions ? { permissions: options.permissions } : {}),
  };
}

/**
 * Strip and re-shape a tag list.
 *
 * Tags are normalised to lowercase-slug form so that "C++", "c++" and "C ++"
 * do not become three separate tags splitting one topic's documents.
 */
export function normaliseTags(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const tag of raw) {
    const cleaned = tag.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!cleaned) continue;
    const slug = cleaned
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase()
      .replace(/[^a-z0-9+#.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(cleaned);
    if (out.length >= 20) break;
  }

  return out;
}

/** Guard used by tests to assert the mapper has not started leaking. */
export function assertNoForbiddenFields(dto: object): void {
  const serialised = JSON.stringify(dto);
  for (const field of FORBIDDEN_FIELDS) {
    if (serialised.includes(field)) {
      throw new Error(
        `Document DTO leaks the storage-side field "${field}". ` +
          'Exposing a storage key or bucket lets a user bypass authorization and fetch files directly.',
      );
    }
  }
}
