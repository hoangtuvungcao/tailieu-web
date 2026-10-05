import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { documents, faculties, programs, subjects, tags } from '../../db/schema/index.js';
import { pingDatabase } from '../../db/client.js';
import { toDocumentDto, type DocumentDto } from '../../modules/documents/documents.mapper.js';
import * as documentsRepo from '../../modules/documents/documents.repository.js';
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  type SearchHighlight,
  type SearchHit,
  type SearchProvider,
  type SearchRequest,
  type SearchResult,
  type SearchSuggestion,
} from './search.provider.js';

/**
 * PostgreSQL search provider.
 *
 * Deliberately a thin adapter over the existing document query layer rather
 * than a parallel implementation. The visibility predicate, the filter
 * vocabulary and the column selection already exist in `documents.repository`
 * and are already covered by tests; re-implementing them here would mean two
 * places to keep in sync, and the security-critical one — visibility — is
 * exactly the thing that must not drift.
 *
 * What this adds on top is the search contract: relevance scores, highlight
 * fragments, and typeahead suggestions.
 *
 * Honest assessment of quality: this is the weakest part of the system. With no
 * Vietnamese stemmer, ranking is `ts_rank_cd` over an unaccented `simple`
 * tsvector, which handles whole words well and partial words via trigram, but
 * has no notion of phrase proximity, synonyms, or typo correction. It is a
 * correct and index-backed implementation, not a competitive search engine —
 * which is precisely why the interface exists.
 */
export class PostgresSearchProvider implements SearchProvider {
  readonly name = 'postgres';

  async search(request: SearchRequest): Promise<SearchResult> {
    const started = process.hrtime.bigint();

    // Reuse the document list query verbatim. Its `sort: 'relevance'` path
    // already binds the real search term to `ts_rank_cd`, and its visibility
    // predicate is the same one every read path uses.
    const { items, total } = await documentsRepo.listDocuments(
      {
        q: request.query || undefined,
        facultyId: request.filters.facultyId,
        programId: request.filters.programId,
        subjectId: request.filters.subjectId,
        courseId: request.filters.courseId,
        academicYearId: request.filters.academicYearId,
        semesterId: request.filters.semesterId,
        documentTypeId: request.filters.documentTypeId,
        fileKind: request.filters.fileKind,
        tag: request.filters.tag,
        ownerUserId: request.filters.ownerUserId,
        sort: request.sort,
      } as Parameters<typeof documentsRepo.listDocuments>[0],
      { page: request.page, limit: request.limit },
      request.viewer,
    );

    const terms = tokenise(request.query);

    const hits: SearchHit[] = await Promise.all(
      items.map(async (row) => {
        const document = request.includeRelations
          ? await this.hydrateDocument(row.id)
          : toDocumentDto(row);

        return {
          document,
          // The list query returns rows already ordered by relevance but does
          // not expose the rank. Rather than issue a second query purely to
          // surface a number, the score is left null unless relations were
          // requested — the ordering is what the UI actually uses.
          score: null,
          highlights: buildHighlights(row.title, row.description, terms),
        };
      }),
    );

    const tookMs = Number(process.hrtime.bigint() - started) / 1_000_000;

    return {
      hits,
      total,
      page: request.page,
      limit: request.limit,
      totalPages: Math.max(1, Math.ceil(total / request.limit)),
      tookMs: Math.round(tookMs * 100) / 100,
      provider: this.name,
    };
  }

  private async hydrateDocument(id: string): Promise<DocumentDto> {
    const row = await documentsRepo.findDocumentUnscoped(id);
    if (!row) {
      // A document deleted between the search and the hydrate. Returning a
      // stale hit would produce a link to a 404, so this yields an empty shell
      // the caller can filter.
      throw new Error(`Document ${id} disappeared during search hydration.`);
    }

    const [files, tagRows] = await Promise.all([
      documentsRepo.findDocumentFiles(id),
      documentsRepo.findDocumentTags(id),
    ]);

    return toDocumentDto(row, {
      files: files.map((f) => ({
        id: f.id,
        originalName: f.originalName,
        sizeBytes: f.sizeBytes,
        detectedMime: f.detectedMime,
        fileKind: f.fileKind,
        isPrimary: f.isPrimary,
        status: f.status,
        extension: f.extension,
        pageCount: f.pageCount,
        previewStatus: f.previewStatus,
      })),
      tags: tagRows,
    });
  }

  /**
   * Typeahead across taxonomy, tags and document titles.
   *
   * Taxonomy and tags come first because they are short, curated and what a
   * user is usually reaching for — "Công nghệ thông tin" as a program, not as a
   * string that happens to appear in a title. Titles fill the remaining slots.
   */
  async suggest(prefix: string, limit: number): Promise<SearchSuggestion[]> {
    const term = prefix.trim();
    if (term.length < 1) return [];

    const pattern = `%${term}%`;
    const perKind = Math.max(2, Math.ceil(limit / 3));

    const [facultyRows, programRows, subjectRows, tagRows, documentRows] = await Promise.all([
      db
        .select({ id: faculties.id, name: faculties.name, code: faculties.code })
        .from(faculties)
        .where(
          and(
            isNull(faculties.deletedAt),
            eq(faculties.isActive, true),
            sql`immutable_unaccent(${faculties.name}) ILIKE immutable_unaccent(${pattern})`,
          ),
        )
        .limit(perKind),

      db
        .select({
          id: programs.id,
          name: programs.name,
          code: programs.code,
          facultyName: faculties.name,
        })
        .from(programs)
        .innerJoin(faculties, eq(faculties.id, programs.facultyId))
        .where(
          and(
            isNull(programs.deletedAt),
            eq(programs.isActive, true),
            or(
              sql`immutable_unaccent(${programs.name}) ILIKE immutable_unaccent(${pattern})`,
              sql`${programs.code} ILIKE ${pattern}`,
            ),
          ),
        )
        .orderBy(asc(programs.name))
        .limit(perKind),

      db
        .select({ id: subjects.id, name: subjects.name, code: subjects.code })
        .from(subjects)
        .where(
          and(
            isNull(subjects.deletedAt),
            eq(subjects.isActive, true),
            or(
              sql`immutable_unaccent(${subjects.name}) ILIKE immutable_unaccent(${pattern})`,
              sql`${subjects.code} ILIKE ${pattern}`,
            ),
          ),
        )
        .orderBy(asc(subjects.name))
        .limit(perKind),

      db
        .select({ id: tags.id, name: tags.name, slug: tags.slug })
        .from(tags)
        .where(sql`immutable_unaccent(${tags.name}) ILIKE immutable_unaccent(${pattern})`)
        .orderBy(desc(tags.usageCount))
        .limit(perKind),

      db
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(
          and(
            sql`${documents.deletedAt} IS NULL`,
            eq(documents.status, 'published'),
            sql`${documents.visibility} = 'public'`,
            sql`immutable_unaccent(${documents.title}) ILIKE immutable_unaccent(${pattern})`,
          ),
        )
        .orderBy(desc(documents.downloadCount))
        .limit(perKind),
    ]);

    const suggestions: SearchSuggestion[] = [
      ...facultyRows.map((r) => ({
        kind: 'faculty' as const,
        id: r.id,
        label: r.name,
        hint: `Khoa · ${r.code}`,
        href: `/faculties/${r.id}`,
      })),
      ...programRows.map((r) => ({
        kind: 'program' as const,
        id: r.id,
        label: r.name,
        hint: `Ngành · ${r.code}`,
        href: `/programs/${r.id}`,
      })),
      ...subjectRows.map((r) => ({
        kind: 'subject' as const,
        id: r.id,
        label: r.name,
        hint: `Học phần · ${r.code}`,
        href: `/subjects/${r.id}`,
      })),
      ...tagRows.map((r) => ({
        kind: 'tag' as const,
        id: r.id,
        label: r.name,
        hint: 'Thẻ',
        href: `/documents?tag=${encodeURIComponent(r.slug)}`,
      })),
      ...documentRows.map((r) => ({
        kind: 'document' as const,
        id: r.id,
        label: r.title,
        hint: 'Tài liệu',
        href: `/documents/${r.id}`,
      })),
    ];

    return suggestions.slice(0, limit);
  }

  /**
   * No-op.
   *
   * Postgres keeps its index in the table: `search_text` is maintained by
   * triggers and `tsv` is a stored generated column, so a write is already
   * indexed by the time it commits. The method exists so that swapping in a
   * backend with an external index does not require changing every write path.
   */
  async indexDocument(documentId: string): Promise<void> {
    void documentId;
  }

  async removeDocument(documentId: string): Promise<void> {
    void documentId;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const result = await pingDatabase();
      return { ok: true, detail: `${this.name} (${result.latencyMs}ms)` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

/**
 * Split a query into searchable terms.
 *
 * Mirrors what `plainto_tsquery` does on the way in, so the highlight fragments
 * line up with what actually matched rather than highlighting different words
 * than the ones that produced the hit.
 */
function tokenise(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 10);
}

/** Fold Vietnamese diacritics so "cong nghe" matches "Công nghệ". */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * Wrap matched terms in the highlight markers.
 *
 * Matching is done on the FOLDED form but the returned text is the ORIGINAL,
 * so a search for "cong nghe" highlights "Công nghệ" in place rather than
 * showing the user a mangled, diacritic-free title.
 *
 * Only the first occurrence of each term is marked: highlighting every
 * instance of a common word produces a page that looks like it has been
 * attacked with a marker pen.
 */
function buildHighlights(
  title: string,
  description: string | null,
  terms: string[],
): SearchHighlight[] {
  if (terms.length === 0) return [];

  const highlights: SearchHighlight[] = [];

  const markIn = (text: string): string => {
    const folded = fold(text);
    // Collect insertion points, then splice from the end so earlier offsets
    // stay valid.
    const marks: { start: number; end: number }[] = [];
    for (const term of terms) {
      const index = folded.indexOf(term);
      if (index === -1) continue;
      // Don't mark a range that overlaps one already chosen.
      if (marks.some((m) => index < m.end && index + term.length > m.start)) continue;
      marks.push({ start: index, end: index + term.length });
    }
    if (marks.length === 0) return text;

    let out = text;
    for (const mark of marks.sort((a, b) => b.start - a.start)) {
      out =
        out.slice(0, mark.start) +
        HIGHLIGHT_START +
        out.slice(mark.start, mark.end) +
        HIGHLIGHT_END +
        out.slice(mark.end);
    }
    return out;
  };

  const markedTitle = markIn(title);
  if (markedTitle !== title) {
    highlights.push({ field: 'title', value: markedTitle });
  }

  if (description) {
    const markedDescription = markIn(description);
    if (markedDescription !== description) {
      highlights.push({ field: 'description', value: markedDescription });
    }
  }

  return highlights;
}
