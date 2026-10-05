import { useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  FolderOpen,
  Home as HomeIcon,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Search,
  Sun,
  Upload,
  User as UserIcon,
  X,
} from 'lucide-react';
import { Suspense, lazy, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { Badge, Button, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { CollectionDetailPage } from '@/pages/CollectionDetail';
import { CollectionsPage } from '@/pages/Collections';
import { CommunityPage } from '@/pages/Community';
import { PostDetailPage } from '@/pages/PostDetail';
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

function Header() {
  const { user, isAuthenticated, isLoading, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer on navigation, otherwise it stays open over the
  // page the user just navigated to.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-background)]/85 backdrop-blur">
      <div className="container-page flex h-16 items-center gap-4">
        <Link to="/" className="flex shrink-0 items-center gap-2">
          {/* A secondary mark, deliberately not the official university logo —
              an invented symbol avoids misrepresenting an official emblem. */}
          <span
            aria-hidden
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--color-brand-700)] text-[var(--color-brand-50)]"
          >
            <BookOpen className="h-5 w-5" />
          </span>
          <span className="flex flex-col leading-none">
            <span className="text-sm font-bold tracking-tight">TAILIEU TTN</span>
            <span className="hidden text-[11px] text-[var(--color-muted-foreground)] sm:block">
              Đại học Tây Nguyên
            </span>
          </span>
        </Link>

        <nav aria-label="Điều hướng chính" className="hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-[var(--color-secondary)] text-[var(--color-foreground)]'
                    : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)]',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link to="/documents" className="hidden sm:block">
            <Button variant="outline" size="sm" className="gap-2">
              <Search className="h-4 w-4" />
              Tìm kiếm
            </Button>
          </Link>

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
              <div className="hidden items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 sm:flex">
                <UserIcon className="h-4 w-4 text-[var(--color-muted-foreground)]" />
                <span className="max-w-32 truncate text-sm">{user.displayName}</span>
                {user.roles.includes('admin') ||
                user.roles.includes('super_admin') ||
                user.roles.includes('moderator') ||
                user.roles.includes('faculty_moderator') ? (
                  // Only roles that can actually reach at least one admin
                  // screen. Showing it to a student would be a link to a wall.
                  <Link to="/admin" aria-label="Trang quản trị">
                    <Badge variant="gold">Quản trị</Badge>
                  </Link>
                ) : null}
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

          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setMobileOpen((open) => !open)}
            aria-label={mobileOpen ? 'Đóng menu' : 'Mở menu'}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {mobileOpen ? (
        <nav
          aria-label="Điều hướng di động"
          className="border-t border-[var(--color-border)] bg-[var(--color-background)] md:hidden"
        >
          <div className="container-page flex flex-col py-2">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium',
                    isActive
                      ? 'bg-[var(--color-secondary)]'
                      : 'text-[var(--color-muted-foreground)]',
                  )
                }
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            ))}
            {isAuthenticated ? (
              <NavLink
                to="/upload"
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-[var(--color-muted-foreground)]"
              >
                <Upload className="h-4 w-4" />
                Tải lên
              </NavLink>
            ) : null}
          </div>
        </nav>
      ) : null}
    </header>
  );
}

function Footer() {
  return (
    <footer className="mt-16 border-t border-[var(--color-border)] py-8">
      <div className="container-page flex flex-col gap-2 text-sm text-[var(--color-muted-foreground)] sm:flex-row sm:items-center sm:justify-between">
        <p>TAILIEU TTN — Kho tri thức cộng đồng Đại học Tây Nguyên</p>
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
      <div className="flex items-stretch justify-around">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium',
                isActive
                  ? 'text-[var(--color-primary)]'
                  : 'text-[var(--color-muted-foreground)]',
              )
            }
          >
            <item.icon className="h-5 w-5" aria-hidden />
            {item.label}
          </NavLink>
        ))}

        {isAuthenticated ? (
          <NavLink
            to="/upload"
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium',
                isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted-foreground)]',
              )
            }
          >
            <Upload className="h-5 w-5" aria-hidden />
            Tải lên
          </NavLink>
        ) : (
          <NavLink
            to="/login"
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-medium',
                isActive ? 'text-[var(--color-primary)]' : 'text-[var(--color-muted-foreground)]',
              )
            }
          >
            <UserIcon className="h-5 w-5" aria-hidden />
            Đăng nhập
          </NavLink>
        )}
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
  useEffect(() => {
    queryClient.clear();
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
        <Route path="documents/:id" element={<DocumentDetailPage />} />
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
