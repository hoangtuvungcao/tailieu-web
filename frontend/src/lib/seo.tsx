import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Per-route document metadata.
 *
 * A single-page app has one `<head>` for every route, so without this every
 * page shares the home page's title and description — which is what search
 * engines index and what a shared link previews. The defaults live in
 * `index.html` for crawlers that do not run JavaScript; this exists for the
 * ones that do, and for the browser tab.
 *
 * THE DESIGN PROBLEM, AND WHY THIS SHAPE. The obvious implementation is a
 * `useSeo()` hook each page calls in an effect. That races: React runs effects
 * child-first, so a page's effect would run before an app-level effect that
 * applies defaults, and the defaults would win. Clearing state on navigation
 * has the same problem from the other side — the clear and the set happen in
 * the same commit.
 *
 * So there is exactly ONE writer. The provider derives the default metadata
 * from the current path, a page may override it, and the override is tagged
 * with the path it was set for. When the path changes the tag no longer
 * matches and the default applies immediately, without anyone having to clear
 * anything — there is no window where stale metadata is live and no ordering
 * to get wrong.
 */

export interface SeoMeta {
  title: string;
  description?: string;
  /** Path for the canonical URL. Defaults to the current pathname. */
  canonicalPath?: string;
  /** `article` makes a shared document link preview as content, not a page. */
  type?: 'website' | 'article' | 'profile';
  image?: string;
  imageAlt?: string;
  /** Emitted as a JSON-LD script tag, replacing any previous one. */
  jsonLd?: Record<string, unknown> | null;
  /** Keeps an authenticated page out of the index. */
  noIndex?: boolean;
}

const SITE_NAME = 'TAILIEU TTN';
const DEFAULT_DESCRIPTION =
  'Nền tảng chia sẻ tài liệu học tập, đề thi, bài giảng và kết nối cộng đồng học thuật Đại học Tây Nguyên.';
const DEFAULT_IMAGE = '/og-image.png';

/** Title/description for a path, before any page-level override. */
const ROUTE_DEFAULTS: Record<string, { title: string; description?: string }> = {
  '/': { title: `${SITE_NAME} — Kho tri thức Đại học Tây Nguyên` },
  '/documents': {
    title: `Tài liệu — ${SITE_NAME}`,
    description:
      'Tìm kiếm và tải tài liệu, đề thi, bài giảng theo khoa, ngành, học phần và năm học.',
  },
  '/community': {
    title: `Cộng đồng — ${SITE_NAME}`,
    description: 'Hỏi đáp, chia sẻ và thảo luận học thuật cùng sinh viên Đại học Tây Nguyên.',
  },
  '/leaderboards': {
    title: `Bảng xếp hạng — ${SITE_NAME}`,
    description: 'Những thành viên đóng góp nhiều nhất cho kho tài liệu.',
  },
  '/login': { title: `Đăng nhập — ${SITE_NAME}`, description: undefined },
  '/register': {
    title: `Đăng ký — ${SITE_NAME}`,
    description: 'Tạo tài khoản để chia sẻ và lưu trữ tài liệu học tập.',
  },
  '/bookmarks': { title: `Đã lưu — ${SITE_NAME}` },
  '/collections': { title: `Bộ sưu tập — ${SITE_NAME}` },
  '/notifications': { title: `Thông báo — ${SITE_NAME}` },
  '/settings/profile': { title: `Chỉnh sửa hồ sơ — ${SITE_NAME}` },
  '/settings/account': { title: `Tài khoản — ${SITE_NAME}` },
  '/upload': { title: `Tải lên tài liệu — ${SITE_NAME}` },
};

/** Prefix matches, for routes with a dynamic segment. */
const PREFIX_DEFAULTS: { prefix: string; title: string }[] = [
  { prefix: '/documents/', title: `Tài liệu — ${SITE_NAME}` },
  { prefix: '/users/', title: `Hồ sơ — ${SITE_NAME}` },
  // `/community/:id`, not `/posts/:id` — there is no `/posts` route, and a
  // prefix that matches nothing silently leaves posts on the home page's title.
  { prefix: '/community/', title: `Bài đăng — ${SITE_NAME}` },
  { prefix: '/admin', title: `Quản trị — ${SITE_NAME}` },
];

/** Routes that must never be indexed. */
const PRIVATE_PREFIXES = [
  '/admin',
  '/settings',
  '/notifications',
  '/bookmarks',
  '/collections',
  '/upload',
];

/**
 * Title/description for a path, before any page-level override.
 *
 * Exported for the test that checks the dynamic prefixes still match the routes
 * they name. A prefix that matches nothing is invisible — the page simply
 * inherits the homepage's title — which is how `/posts/` sat here for a while
 * after the post route was renamed to `/community/`.
 */
export function routeDefault(title: string): SeoMeta {
  const exact = ROUTE_DEFAULTS[title];
  if (exact) return { title: exact.title, description: exact.description };

  const prefixed = PREFIX_DEFAULTS.find((entry) => title.startsWith(entry.prefix));
  if (prefixed) return { title: prefixed.title };

  return {
    title: `${SITE_NAME} — Kho tri thức Đại học Tây Nguyên`,
    description: DEFAULT_DESCRIPTION,
  };
}

/** Exported for the test that asserts private routes are excluded. */
export function isPrivate(path: string): boolean {
  return PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// =============================================================================
// DOM application
// =============================================================================

/** Absolute URL for a path, using the origin the page is actually served from. */
function absolute(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${window.location.origin}${path.startsWith('/') ? path : `/${path}`}`;
}

function setMeta(selector: string, attribute: 'name' | 'property', key: string, content: string): void {
  let element = document.head.querySelector<HTMLMetaElement>(selector);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

function setLink(rel: string, href: string): void {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement('link');
    element.setAttribute('rel', rel);
    document.head.appendChild(element);
  }
  element.setAttribute('href', href);
}

const JSONLD_SELECTOR = 'script[type="application/ld+json"][data-seo]';

function applySeo(meta: SeoMeta, pathname: string): void {
  const path = meta.canonicalPath ?? pathname;
  const url = absolute(path);
  const description = meta.description ?? DEFAULT_DESCRIPTION;
  const image = absolute(meta.image ?? DEFAULT_IMAGE);

  document.title = meta.title;

  setMeta('meta[name="description"]', 'name', 'description', description);
  setLink('canonical', url);

  // A private page is excluded rather than merely unlinked: these render a
  // sign-in form or a user's own data to a crawler, and an indexed page that
  // says "please sign in" is a bad search result even when it leaks nothing.
  const robots = meta.noIndex || isPrivate(path) ? 'noindex, nofollow' : 'index, follow';
  setMeta('meta[name="robots"]', 'name', 'robots', robots);

  setMeta('meta[property="og:title"]', 'property', 'og:title', meta.title);
  setMeta('meta[property="og:description"]', 'property', 'og:description', description);
  setMeta('meta[property="og:url"]', 'property', 'og:url', url);
  setMeta('meta[property="og:image"]', 'property', 'og:image', image);
  setMeta('meta[property="og:type"]', 'property', 'og:type', meta.type ?? 'website');

  setMeta('meta[name="twitter:title"]', 'name', 'twitter:title', meta.title);
  setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', description);
  setMeta('meta[name="twitter:image"]', 'name', 'twitter:image', image);

  if (meta.imageAlt) {
    setMeta('meta[property="og:image:alt"]', 'property', 'og:image:alt', meta.imageAlt);
  }

  document.head.querySelectorAll(JSONLD_SELECTOR).forEach((node) => node.remove());
  if (meta.jsonLd) {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.setAttribute('data-seo', '');
    // textContent, not innerHTML: the payload contains user-supplied titles and
    // descriptions, and this is the one place they reach the document as markup.
    script.textContent = JSON.stringify(meta.jsonLd);
    document.head.appendChild(script);
  }
}

// =============================================================================
// Provider and hook
// =============================================================================

interface SeoContextValue {
  /** Records a page's metadata, tagged with the path it applies to. */
  setPageMeta: (entry: { path: string; meta: SeoMeta }) => void;
}

const SeoContext = createContext<SeoContextValue | null>(null);

export function SeoProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [pageMeta, setPageMeta] = useState<{ path: string; meta: SeoMeta } | null>(null);

  // A page's metadata only counts while that page is the current route. On
  // navigation the tag stops matching and the route default takes over in the
  // same render, so no stale title is ever live.
  const effective = useMemo(
    () => (pageMeta && pageMeta.path === pathname ? pageMeta.meta : routeDefault(pathname)),
    [pageMeta, pathname],
  );

  useEffect(() => {
    applySeo(effective, pathname);
  }, [effective, pathname]);

  const value = useMemo<SeoContextValue>(() => ({ setPageMeta }), []);

  return <SeoContext.Provider value={value}>{children}</SeoContext.Provider>;
}

/**
 * Sets this page's metadata.
 *
 * Call it unconditionally, at the top of a page component, with the same
 * argument shape every render — the effect compares by value, so an inline
 * object literal is fine but a new object every render will not loop, because
 * the effect only re-runs when the serialised value changes.
 */
export function useSeo(meta: SeoMeta): void {
  const context = useContext(SeoContext);
  const { pathname } = useLocation();

  const serialised = JSON.stringify(meta);

  const setPageMeta = context?.setPageMeta;

  useEffect(() => {
    if (!setPageMeta) return;
    setPageMeta({ path: pathname, meta: JSON.parse(serialised) as SeoMeta });
    // `serialised` is the value identity; `meta` itself is a fresh object each
    // render by design.
  }, [setPageMeta, pathname, serialised]);
}

/** Convenience for a page that only needs a title. */
export function usePageTitle(title: string): void {
  useSeo({ title });
}
