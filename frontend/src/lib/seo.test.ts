import { describe, expect, it } from 'vitest';

import { isPrivate, routeDefault } from './seo';

/**
 * Route metadata.
 *
 * The failure these lock in is a silent one. A prefix in `PREFIX_DEFAULTS` that
 * no longer matches a real route does not error — the page keeps the homepage's
 * title and description, and the only symptom is that search engines index
 * every post as "TAILIEU TTN — Kho tri thức Đại học Tây Nguyên". That happened:
 * the post route is `/community/:id` and the table said `/posts/`.
 *
 * So the assertion is not "this string is present" but "the routes the app
 * actually has resolve to their own metadata".
 */

const SITE_NAME = 'TAILIEU TTN';

describe('routeDefault', () => {
  it('gives each static page its own title', () => {
    // The homepage's own title, which nothing else may fall back to silently.
    const home = routeDefault('/').title;

    for (const path of ['/documents', '/community', '/leaderboards', '/upload']) {
      const title = routeDefault(path).title;
      expect(title).not.toBe(home);
      expect(title).toContain(SITE_NAME);
    }
  });

  it('resolves the dynamic routes the app actually declares', () => {
    // These are the `:id` routes in App.tsx. Each must reach a prefix default,
    // which is why the alternative — the homepage title — is asserted against.
    const dynamic = ['/documents/abc', '/users/abc', '/community/abc'];

    for (const path of dynamic) {
      expect(routeDefault(path).title).not.toBe(routeDefault('/').title);
    }

    expect(routeDefault('/community/abc').title).toContain('Bài đăng');
    expect(routeDefault('/users/abc').title).toContain('Hồ sơ');
    expect(routeDefault('/documents/abc').title).toContain('Tài liệu');
  });

  it('matches on the segment, not on a bare prefix', () => {
    // `/documents-archive` starts with `/documents` but is a different route;
    // the prefix table keys on `/documents/`, so it must not match.
    expect(routeDefault('/documents-archive').title).toBe(routeDefault('/').title);
  });

  it('falls back to the site default for an unknown path', () => {
    expect(routeDefault('/khong-ton-tai').title).toBe(routeDefault('/').title);
    expect(routeDefault('/khong-ton-tai').description).toBeTruthy();
  });
});

describe('isPrivate', () => {
  it('excludes every authenticated area from the index', () => {
    for (const path of [
      '/admin',
      '/admin/users',
      '/settings',
      '/settings/profile',
      '/notifications',
      '/bookmarks',
      '/collections',
      '/collections/abc',
      '/upload',
    ]) {
      expect(isPrivate(path), path).toBe(true);
    }
  });

  it('leaves the public pages indexable', () => {
    for (const path of ['/', '/documents', '/documents/abc', '/community', '/users/abc', '/leaderboards']) {
      expect(isPrivate(path), path).toBe(false);
    }
  });

  it('does not treat a path that merely shares a prefix as private', () => {
    // `/bookmarks-public` is not `/bookmarks`; a bare `startsWith` without the
    // separator would hide a public page from search engines.
    expect(isPrivate('/bookmarks-public')).toBe(false);
    expect(isPrivate('/settings-guide')).toBe(false);
  });
});
