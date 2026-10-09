/**
 * Cloudflare Pages Function — `/sitemap.xml`.
 *
 * A document library's sitemap is mostly its documents, so a hand-written file
 * listing only the marketing routes would be a sitemap in name. This builds one
 * from the same public API a visitor reads, which also means the entries go
 * through the API's own visibility predicate: a `private` or `internal`
 * document cannot appear here, and neither can a draft. That matters more than
 * freshness — a sitemap that leaks an unpublished thesis title to a crawler is
 * a disclosure, not an SEO bug.
 *
 * Two properties keep it from becoming a load problem, given the API is a
 * laptop behind a tunnel:
 *
 *   IT IS CACHED AT THE EDGE. `s-maxage` means Cloudflare answers the crawler
 *   and the origin is called at most once per window, however many crawlers
 *   arrive.
 *
 *   IT DEGRADES TO THE STATIC ROUTES. If the tunnel is down the sitemap still
 *   parses and still lists the pages that do not depend on the API. A sitemap
 *   that 500s is reported to the site owner as a permanent error by Search
 *   Console, which is worse than a shorter one.
 */

interface Env {
  /** Tunnel origin of the backend, same variable the API proxy reads. */
  API_ORIGIN?: string;
}

interface ApiListResponse {
  success: boolean;
  data?: { id: string; updatedAt?: string }[];
  meta?: { totalPages?: number };
}

/** Pages that exist for a signed-out visitor, so belong in every sitemap. */
const STATIC_ROUTES: { path: string; changefreq: string; priority: string }[] = [
  { path: '/', changefreq: 'daily', priority: '1.0' },
  { path: '/documents', changefreq: 'daily', priority: '0.9' },
  { path: '/policy/copyright', changefreq: 'monthly', priority: '0.6' },
  { path: '/community', changefreq: 'daily', priority: '0.8' },
  { path: '/leaderboards', changefreq: 'weekly', priority: '0.5' },
];

/**
 * How many documents to enumerate, and how many per request.
 *
 * The API caps `limit` at 100. 5,000 entries is comfortably under the 50,000
 * sitemap limit and is far more than the library holds today; the cap exists so
 * that a large library cannot make this function hammer the origin for a
 * minute on every cache miss.
 */
const MAX_DOCUMENTS = 5000;
const PAGE_SIZE = 100;

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      default:
        return '&quot;';
    }
  });
}

async function fetchDocuments(origin: string): Promise<{ id: string; updatedAt?: string }[]> {
  const collected: { id: string; updatedAt?: string }[] = [];

  for (let page = 1; page * PAGE_SIZE <= MAX_DOCUMENTS; page++) {
    const url = `${origin}/api/v1/documents?page=${page}&limit=${PAGE_SIZE}&sort=newest`;

    let body: ApiListResponse;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        // A crawler is waiting. Better a shorter sitemap than a hung request.
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) break;
      body = (await response.json()) as ApiListResponse;
    } catch {
      // Tunnel or laptop unavailable. Stop, and let the caller emit what it has.
      break;
    }

    const items = body.data ?? [];
    collected.push(...items);

    const totalPages = body.meta?.totalPages ?? 1;
    if (page >= totalPages || items.length === 0) break;
  }

  return collected;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const origin = new URL(context.request.url).origin;
  const apiOrigin = context.env.API_ORIGIN ?? 'http://localhost:3000';

  const documents = await fetchDocuments(apiOrigin);

  const entries: string[] = [];

  for (const route of STATIC_ROUTES) {
    entries.push(
      [
        '  <url>',
        `    <loc>${escapeXml(`${origin}${route.path}`)}</loc>`,
        `    <changefreq>${route.changefreq}</changefreq>`,
        `    <priority>${route.priority}</priority>`,
        '  </url>',
      ].join('\n'),
    );
  }

  for (const document of documents) {
    // The detail route is keyed by id, not slug, so the id is what resolves.
    // An SEO-friendly slug URL would be prettier and would 404.
    const loc = `${origin}/documents/${document.id}`;
    const lines = ['  <url>', `    <loc>${escapeXml(loc)}</loc>`];
    if (document.updatedAt) {
      lines.push(`    <lastmod>${escapeXml(document.updatedAt.slice(0, 10))}</lastmod>`);
    }
    lines.push('    <changefreq>weekly</changefreq>', '    <priority>0.7</priority>', '  </url>');
    entries.push(lines.join('\n'));
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      // Six hours at the edge, a day of stale-while-revalidate behind it. The
      // origin is a laptop; a crawler must not be able to wake it repeatedly.
      'cache-control': 'public, s-maxage=21600, stale-while-revalidate=86400',
    },
  });
};
