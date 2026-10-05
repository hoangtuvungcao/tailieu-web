import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_STATUS_LABELS,
  FILE_KIND_LABELS,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  formatBytes,
  formatDate,
  formatRelativeTime,
  parseHighlight,
} from './utils';

/**
 * Formatting and parsing helpers.
 *
 * `parseHighlight` is the one that matters beyond cosmetics. The API returns
 * search titles with matched terms wrapped in control characters, and the
 * frontend must split them into segments rendered as **text nodes**. If anyone
 * ever replaces that with `dangerouslySetInnerHTML`, a document titled
 * `<script>alert(1)</script>` becomes stored XSS on the search results page.
 * This suite pins the parse so a future refactor has to confront that.
 */

describe('parseHighlight', () => {
  it('splits a highlighted string into matched and unmatched segments', () => {
    const value = `${HIGHLIGHT_START}Bài${HIGHLIGHT_END} giảng C++`;

    expect(parseHighlight(value)).toEqual([
      { text: 'Bài', matched: true },
      { text: ' giảng C++', matched: false },
    ]);
  });

  it('handles several matches in one string', () => {
    const value = `${HIGHLIGHT_START}Bài${HIGHLIGHT_END} ${HIGHLIGHT_START}giảng${HIGHLIGHT_END}`;

    expect(parseHighlight(value)).toEqual([
      { text: 'Bài', matched: true },
      { text: ' ', matched: false },
      { text: 'giảng', matched: true },
    ]);
  });

  it('returns the whole string unmatched when there are no markers', () => {
    expect(parseHighlight('Bài giảng C++')).toEqual([
      { text: 'Bài giảng C++', matched: false },
    ]);
  });

  it('treats an unbalanced marker as plain text rather than dropping content', () => {
    // A malformed response must degrade to showing the text, not to silently
    // losing half a title.
    const value = `${HIGHLIGHT_START}Bài giảng`;

    const segments = parseHighlight(value);
    expect(segments.map((s) => s.text).join('')).toContain('Bài giảng');
  });

  it('preserves markup-looking text verbatim as a text segment', () => {
    // THE security-relevant assertion. The parser distinguishes structure by
    // control characters only — angle brackets carry no meaning. A caller that
    // renders these segments as text nodes is safe; one that joins them and
    // assigns innerHTML is not.
    const hostile = `${HIGHLIGHT_START}<script>${HIGHLIGHT_END}alert(1)</script>`;

    const segments = parseHighlight(hostile);

    expect(segments[0]).toEqual({ text: '<script>', matched: true });
    expect(segments[1]!.text).toBe('alert(1)</script>');
    // The raw markup survives as data, never as structure.
    expect(segments.every((s) => typeof s.text === 'string')).toBe(true);
  });

  it('handles an empty string', () => {
    expect(parseHighlight('')).toEqual([{ text: '', matched: false }]);
  });
});

describe('formatBytes', () => {
  it('formats across the unit range', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.5 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 2)).toBe('2.0 GB');
  });

  it('handles null and undefined without throwing', () => {
    // File size is nullable for a document whose primary file is still
    // attaching; a formatter that throws here would break the list page.
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
  });
});

describe('formatRelativeTime', () => {
  it('describes recent times in Vietnamese', () => {
    const justNow = new Date(Date.now() - 5_000);
    expect(formatRelativeTime(justNow)).toContain('giây');

    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    expect(formatRelativeTime(twoHoursAgo)).toContain('giờ');
  });

  it('falls back to an absolute date for old values', () => {
    // Past about a year, "13 months ago" is less useful than the date itself.
    const old = new Date(Date.now() - 400 * 86_400_000);
    expect(formatRelativeTime(old)).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('returns an empty string rather than "Invalid Date"', () => {
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime('not-a-date')).toBe('');
  });
});

describe('formatDate', () => {
  it('formats in Vietnamese day-first order', () => {
    expect(formatDate('2026-10-04T00:00:00Z')).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('returns empty for missing or invalid input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('nonsense')).toBe('');
  });
});

describe('label maps', () => {
  it('covers every file kind the API can return', () => {
    // A missing key renders as a raw enum value in the UI ("spreadsheet"
    // instead of "Bảng tính"), which looks broken.
    for (const kind of [
      'pdf', 'document', 'spreadsheet', 'presentation',
      'archive', 'image', 'text', 'code', 'other',
    ]) {
      expect(FILE_KIND_LABELS[kind], `missing label for ${kind}`).toBeTruthy();
    }
  });

  it('covers every document status', () => {
    for (const status of ['draft', 'pending_review', 'published', 'rejected', 'archived']) {
      expect(DOCUMENT_STATUS_LABELS[status], `missing label for ${status}`).toBeTruthy();
    }
  });
});
