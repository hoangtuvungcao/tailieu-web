import { useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Bookmark as BookmarkIcon,
  BookOpen,
  FolderOpen,
  Home as HomeIcon,
  LogOut,
  MessageSquare,
  Moon,
  Search,
  Settings,
  Sun,
  Upload,
  User as UserIcon,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { Logo, LogoMark } from '@/components/Logo';
import { Badge, Button, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useUnreadCount } from '@/lib/social-hooks';
import { cn } from '@/lib/utils';
import { CollectionDetailPage } from '@/pages/CollectionDetail';
import { CollectionsPage } from '@/pages/Collections';
import { BookmarksPage } from '@/pages/Bookmarks';
import { CommunityPage } from '@/pages/Community';
import { LeaderboardPage } from '@/pages/Leaderboard';
import { NotificationsPage } from '@/pages/Notifications';
import { PostDetailPage } from '@/pages/PostDetail';
import { ProfilePage } from '@/pages/Profile';
import { ProfileSettingsPage } from '@/pages/ProfileSettings';
import { DocumentDetailPage } from '@/pages/DocumentDetail';
import { DocumentsPage } from '@/pages/Documents';
import { HomePage } from '@/pages/Home';
import { LoginPage, NotFoundPage, RegisterPage } from '@/pages/auth';
import { UploadPage } from '@/pages/Upload';

// Code-split: the admin screens and their chart code are fetched only when an
// administrator opens them. Every other visitor would otherwise download a
// dashboard they never see.
const AdminLayout = lazy(() =>
  import('@/pages/admin/AdminLayout').then((m) => ({ default: m.AdminLayout })),
);
const AdminDashboardPage = lazy(() =>
  import('@/pages/admin/Dashboard').then((m) => ({ default: m.AdminDashboardPage })),
);
const AdminUsersPage = lazy(() =>
  import('@/pages/admin/Users').then((m) => ({ default: m.AdminUsersPage })),
);
const AdminTaxonomyPage = lazy(() =>
  import('@/pages/admin/Taxonomy').then((m) => ({ default: m.AdminTaxonomyPage })),
);
const AdminReportsPage = lazy(() =>
  import('@/pages/admin/Other').then((m) => ({ default: m.AdminReportsPage })),
);
const AdminAuditPage = lazy(() =>
  import('@/pages/admin/Other').then((m) => ({ default: m.AdminAuditPage })),
);
const AdminStoragePage = lazy(() =>
  import('@/pages/admin/Other').then((m) => ({ default: m.AdminStoragePage })),
);
const AdminSettingsPage = lazy(() =>
  import('@/pages/admin/Other').then((m) => ({ default: m.AdminSettingsPage })),
);

/**
 * Application shell and routing.
 *
 * Route-level code splitting is intentionally NOT used yet. The whole client is
 * a few hundred kilobytes and the heaviest dependency is the React runtime
 * itself, which loads on every route anyway — splitting would add a round trip
 * through the Cloudflare tunnel for no gain. The split point to introduce
 * first is the document previewer, which is genuinely large and only needed on
 * one route.
 */

const NAV_ITEMS = [
  { to: '/', label: 'Trang chủ', icon: HomeIcon, end: true },
  { to: '/documents', label: 'Tài liệu', icon: BookOpen },
  { to: '/community', label: 'Cộng đồng', icon: MessageSquare },
  { to: '/collections', label: 'Bộ sưu tập', icon: FolderOpen },
  // TODO: a faculties browse page is not built yet. The nav entry was removed
  // rather than left pointing at an unrouted path, which would 404 for anyone
  // who clicked it. Faculty filtering is reachable from the homepage chips.
];

/**
 * Shared by the static nav and the signed-in-only entries, so the two cannot
 * drift into looking like different kinds of link.
 */
function desktopNavClass({ isActive }: { isActive: boolean }): string {
  return cn(
    // `whitespace-nowrap`: without it a squeezed nav wraps "Bộ sưu tập" onto two
    // lines and the header grows to match — which is what it did at every width
    // from 768px to 1920px, because the nav was the flex item that gave way.
    // The nav now refuses to shrink instead, and the breakpoint moves to `lg`
    // where the whole row genuinely fits.
    // `px-2 xl:px-3`: at exactly 1024px the row is ~50px too wide with the
    // roomier padding, and a horizontal scrollbar on the header is worse than
    // slightly tighter links. The padding returns once there is room.
    'whitespace-nowrap rounded-md px-2 py-2 text-sm font-medium transition-colors xl:px-3',
    isActive
      ? 'bg-[var(--color-secondary)] text-[var(--color-foreground)]'
      : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)]',
  );
}

/**
 * Destinations in the phone bottom bar.
 *
 * Not the same list as the desktop nav, and the difference is deliberate. The
 * bar holds five and no more: a sixth leaves every label fighting for 60px on a
 * 360px screen, which is how "Bộ sưu tập" ended up on two lines. So the bar
 * carries the four things a reader does constantly plus the one action they
 * take — and "Đã lưu" earns its slot over "Bộ sưu tập", because it is your own
 * list rather than a public one. Collections and the ranking live on the
 * profile, which the header now links to at every width.
 */
const MOBILE_NAV_ITEMS = [
  { to: '/', label: 'Trang chủ', icon: HomeIcon, end: true },
  { to: '/documents', label: 'Tài liệu', icon: BookOpen },
  { to: '/community', label: 'Cộng đồng', icon: MessageSquare },
  { to: '/bookmarks', label: 'Đã lưu', icon: BookmarkIcon, authOnly: true },
];

/**
 * Phone bottom-bar entry.
 *
 * `min-w-0` as well as `whitespace-nowrap`: nowrap stops a label becoming two
 * lines, and `min-w-0` stops five of them collectively forcing the bar wider
 * than the screen — which is what it did before, 382px inside a 360px viewport.
 */
function bottomNavClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'flex min-w-0 flex-1 flex-col items-center gap-1 whitespace-nowrap py-2.5 text-[11px] font-medium',
    isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted-foreground)]',
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark'),
  );

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('tailieu-theme', dark ? 'dark' : 'light');
    } catch {
      // Storage unavailable; the theme still applies for this session.
    }
  }, [dark]);

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setDark((value) => !value)}
      // The icon alone does not say what the button does, so the label is
      // explicit and updates with the state.
      aria-label={dark ? 'Chuyển sang chế độ sáng' : 'Chuyển sang chế độ tối'}
      title={dark ? 'Chế độ sáng' : 'Chế độ tối'}
    >
      {dark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </Button>
  );
}

/**
 * The unread badge in the header.
 *
 * Backed by a denormalised counter that the API reads as a primary-key lookup,
 * answering 304 when nothing changed — so an idle tab pays for the poll in
 * headers only. That is what makes a 60-second interval affordable here, where
 * counting notification rows on a timer would not be.
 */
function NotificationBell() {
  const { isAuthenticated } = useAuth();
  // Gate the query, do not merely hide its output. Returning null below stops
  // the badge rendering but not the request, and the request is what logged a
  // 401 on every hard reload — before the session had been restored.
  const { data } = useUnreadCount(isAuthenticated);
  const count = data?.unread ?? 0;

  if (!isAuthenticated) return null;

  return (
    <Link
      to="/notifications"
      className="relative inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-[var(--color-muted)]"
      // The count goes in the label rather than only in the badge: a number
      // inside a coloured dot is invisible to a screen reader.
      aria-label={count > 0 ? `Thông báo, ${count} chưa đọc` : 'Thông báo'}
      title="Thông báo"
    >
      <Bell className="h-5 w-5" aria-hidden />
      {count > 0 ? (
        <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-destructive)] px-1 text-[11px] font-semibold text-[var(--color-destructive-foreground)]">
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}

function Header() {
  const { user, isAuthenticated, isLoading, signOut } = useAuth();

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-background)]/85 backdrop-blur">
      <div className="container-page flex h-16 items-center gap-3 xl:gap-4">
        <Link to="/" className="flex shrink-0 items-center gap-2">
          {/* The product's own mark, not the university's official emblem — an
              invented symbol avoids misrepresenting an official crest.

              The wordmark drops out below 360px, where the mark, the bell, the
              theme toggle and the account control come to 336px in a 320px
              viewport. It is the same trade the Logo makes for the university
              name below `sm`, one step further: the mark still identifies the
              site and it links home, so nothing is lost but a repeated label.
              The next common width up is 360, where the row fits again. */}
          <Logo wordmarkClassName="max-[359px]:hidden" />
        </Link>

        <nav
          aria-label="Điều hướng chính"
          className="hidden shrink-0 items-center gap-0.5 lg:flex xl:gap-1"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={desktopNavClass}>
              {item.label}
            </NavLink>
          ))}
          {/* Signed-in only: a signed-out visitor has nothing saved, and the
              link would only bounce them to a login form. Not in the bottom
              bar — that already carries five destinations, and a sixth leaves
              every label fighting for 60px on a 360px screen. */}
          {isAuthenticated ? (
            <NavLink to="/bookmarks" className={desktopNavClass}>
              Đã lưu
            </NavLink>
          ) : null}
          <NavLink to="/leaderboards" className={desktopNavClass}>
            Xếp hạng
          </NavLink>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* Shown only at `2xl`: this is a shortcut to `/documents`, which the
              nav beside it already links to, and it costs ~120px of a row that
              is tight until the container hits its 1280px cap. The account name
              is worth more here than a duplicate destination. */}
          <Link to="/documents" className="hidden 2xl:block">
            <Button variant="outline" size="sm" className="gap-2">
              <Search className="h-4 w-4" />
              Tìm kiếm
            </Button>
          </Link>

          <NotificationBell />
          <ThemeToggle />

          {isLoading ? (
            <Spinner />
          ) : isAuthenticated && user ? (
            <div className="flex items-center gap-2">
              <Link to="/upload" className="hidden sm:block">
                <Button size="sm" className="gap-2">
                  <Upload className="h-4 w-4" />
                  Tải lên
                </Button>
              </Link>
              {/* Visible at every width, including phones: this is now the only
                  way to reach your own profile, and the profile is the hub for
                  saved items, collections, the ranking and the admin screens.
                  The role badge stays `sm`+ — on a 360px header it would push
                  the row over, and an administrator reaches `/admin` from the
                  profile instead. */}
              <div className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5">
                <Link
                  to={`/users/${user.id}`}
                  className="flex items-center gap-2"
                  aria-label="Hồ sơ của tôi"
                  title="Hồ sơ của tôi"
                >
                  <UserIcon className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden />
                  {/* The name is the widest thing in the header and the least
                      load-bearing: the icon still identifies the menu, and the
                      profile itself says who you are. It appears at `xl`. */}
                  <span className="hidden max-w-32 truncate text-sm xl:inline">
                    {user.displayName}
                  </span>
                </Link>
                {user.roles.includes('admin') ||
                user.roles.includes('super_admin') ||
                user.roles.includes('moderator') ||
                user.roles.includes('faculty_moderator') ? (
                  // Only roles that can actually reach at least one admin
                  // screen. Showing it to a student would be a link to a wall.
                  <Link to="/admin" aria-label="Trang quản trị" className="hidden sm:block">
                    <Badge variant="gold">Quản trị</Badge>
                  </Link>
                ) : null}
                {/* `/settings/profile` is reachable from the profile page at
                    every width. This is the shortcut for the people who edit
                    their avatar often; it stays out of the phone header, where
                    the row is tight and the profile is one tap away anyway. */}
                <Link
                  to="/settings/profile"
                  aria-label="Chỉnh sửa hồ sơ"
                  title="Chỉnh sửa hồ sơ"
                  className="hidden text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] sm:block"
                >
                  <Settings className="h-4 w-4" aria-hidden />
                </Link>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void signOut()}
                aria-label="Đăng xuất"
                title="Đăng xuất"
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link to="/login">
                <Button variant="ghost" size="sm">
                  Đăng nhập
                </Button>
              </Link>
              <Link to="/register" className="hidden sm:block">
                <Button size="sm">Đăng ký</Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-16 border-t border-[var(--color-border)] py-8">
      <div className="container-page flex flex-col gap-2 text-sm text-[var(--color-muted-foreground)] sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2">
          <LogoMark className="h-6 w-6" decorative />
          <span>TAILIEU TTN — Kho tri thức cộng đồng Đại học Tây Nguyên</span>
        </p>
        <p className="text-xs">
          Nền tảng không thay thế cho các nguồn tài liệu chính thức của nhà trường.
        </p>
      </div>
    </footer>
  );
}

/**
 * Mobile bottom navigation.
 *
 * Shown below `md`. The header already carries the same destinations, but on a
 * phone they sit behind a hamburger — one tap further from the primary actions
 * (search, upload), which are exactly the ones that should be one tap away.
 *
 * The container pads for the iOS home indicator via `env(safe-area-inset-bottom)`.
 * Without it the bar sits under the gesture area on modern iPhones and the
 * labels are partially unreachable.
 */
function MobileNav() {
  const { isAuthenticated } = useAuth();

  return (
    <nav
      aria-label="Điều hướng nhanh"
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-[var(--color-border)]',
        'bg-[var(--color-background)]/95 backdrop-blur md:hidden',
      )}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-stretch">
        {MOBILE_NAV_ITEMS.filter((item) => !item.authOnly || isAuthenticated).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className={bottomNavClass}>
            <item.icon className="h-5 w-5" aria-hidden />
            {item.label}
          </NavLink>
        ))}

        {/* The fifth slot is the one action rather than another destination.
            Signed out it becomes the way in, which is the only thing a visitor
            can usefully do from here. */}
        <NavLink to={isAuthenticated ? '/upload' : '/login'} className={bottomNavClass}>
          {isAuthenticated ? (
            <Upload className="h-5 w-5" aria-hidden />
          ) : (
            <UserIcon className="h-5 w-5" aria-hidden />
          )}
          {isAuthenticated ? 'Tải lên' : 'Đăng nhập'}
        </NavLink>
      </div>
    </nav>
  );
}

function Layout() {
  return (
    <div className="flex min-h-full flex-col">
      {/* Keyboard users should be able to skip the navigation; without this
          they tab through the entire header on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-[var(--color-primary)] focus:px-4 focus:py-2 focus:text-[var(--color-primary-foreground)]"
      >
        Bỏ qua điều hướng
      </a>
      <Header />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer />
      <MobileNav />
      {/* Clears the fixed nav, plus the iOS safe area. Without this the last
          row of every list sits underneath the bar and cannot be tapped. */}
      <div
        aria-hidden
        className="md:hidden"
        style={{ height: 'calc(3.5rem + env(safe-area-inset-bottom))' }}
      />
    </div>
  );
}

/**
 * Renders only when signed in.
 *
 * Cosmetic gating only. Every protected endpoint re-checks authorization
 * server-side, so bypassing this in devtools reveals nothing but a page that
 * fails its own data fetches.
 */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // `state.from` lets the login page send the user back where they were
    // heading, rather than dumping everyone on the homepage.
    return <LoginPage redirectTo={location.pathname} />;
  }

  return <>{children}</>;
}

/** Placeholder while an admin chunk loads. */
function AdminFallback() {
  return (
    <div className="container-page flex min-h-[50vh] items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Drop all cached data when the signed-in identity changes. Without this,
  // signing out and in as someone else briefly shows the previous user's
  // documents from the query cache — a real disclosure on a shared machine.
  //
  // Only a CHANGE clears the cache — never the first resolution. `user` is
  // undefined while the session is still being read, so "undefined -> A" is
  // what every single page load looks like, and clearing there wipes the
  // queries that child components started in the same commit. The page then
  // waits forever on data that already arrived: measured, every route NOT
  // gated behind `RequireAuth` sat on its loading skeleton after a reload,
  // while `/bookmarks` and `/notifications` were fine — because RequireAuth
  // mounts its children after auth has settled and so escaped the wipe.
  //
  // Skipping it is safe on a fresh load: the cache is empty at that point
  // anyway, so there is nothing of anyone else's to leak.
  const previousUserId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousUserId.current !== undefined && previousUserId.current !== user?.id) {
      queryClient.clear();
    }
    previousUserId.current = user?.id;
  }, [user?.id, queryClient]);

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="community" element={<CommunityPage />} />
        <Route path="community/:id" element={<PostDetailPage />} />
        <Route path="collections" element={<CollectionsPage />} />
        <Route path="collections/:id" element={<CollectionDetailPage />} />
        {/* Public: a ranking nobody can see does not motivate anyone. */}
        <Route path="leaderboards" element={<LeaderboardPage />} />
        <Route
          path="notifications"
          element={
            <RequireAuth>
              <NotificationsPage />
            </RequireAuth>
          }
        />
        <Route
          path="bookmarks"
          element={
            <RequireAuth>
              <BookmarksPage />
            </RequireAuth>
          }
        />
        <Route path="documents/:id" element={<DocumentDetailPage />} />
        <Route path="users/:id" element={<ProfilePage />} />
        <Route
          path="settings/profile"
          element={
            <RequireAuth>
              <ProfileSettingsPage />
            </RequireAuth>
          }
        />
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route
          path="upload"
          element={
            <RequireAuth>
              <UploadPage />
            </RequireAuth>
          }
        />
        {/* Admin. `RequireAuth` is a convenience gate — every endpoint
            re-checks the permission server-side, so bypassing this in devtools
            reveals a page whose own data fetches fail. */}
        <Route
          path="admin"
          element={
            <RequireAuth>
              <Suspense fallback={<AdminFallback />}>
                <AdminLayout />
              </Suspense>
            </RequireAuth>
          }
        >
          <Route
            index
            element={
              <Suspense fallback={<AdminFallback />}>
                <AdminDashboardPage />
              </Suspense>
            }
          />
          <Route path="users" element={<Suspense fallback={<AdminFallback />}><AdminUsersPage /></Suspense>} />
          <Route path="taxonomy" element={<Suspense fallback={<AdminFallback />}><AdminTaxonomyPage /></Suspense>} />
          <Route path="reports" element={<Suspense fallback={<AdminFallback />}><AdminReportsPage /></Suspense>} />
          <Route path="audit" element={<Suspense fallback={<AdminFallback />}><AdminAuditPage /></Suspense>} />
          <Route path="storage" element={<Suspense fallback={<AdminFallback />}><AdminStoragePage /></Suspense>} />
          <Route path="settings" element={<Suspense fallback={<AdminFallback />}><AdminSettingsPage /></Suspense>} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
