import {
  Activity,
  BarChart3,
  FileCheck,
  Flag,
  HardDrive,
  Layers,
  LayoutDashboard,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';

/**
 * Admin shell.
 *
 * A sidebar rather than the public header: an administrator moves between
 * sections repeatedly, and a persistent list is faster than a menu that opens
 * and closes.
 *
 * Each entry is shown only to someone holding the permission its page requires.
 * That is a convenience, not a control — every endpoint re-checks server-side,
 * so hiding a link only prevents a pointless 403, it does not prevent access.
 */
const SECTIONS = [
  { to: '/admin', label: 'Tổng quan', icon: LayoutDashboard, end: true, permission: 'analytics.read' },
  { to: '/admin/users', label: 'Người dùng', icon: Users, permission: 'users.read' },
  { to: '/admin/taxonomy', label: 'Danh mục', icon: Layers, permission: 'taxonomy.manage' },
  { to: '/admin/documents', label: 'Kiểm duyệt tài liệu', icon: FileCheck, permission: 'documents.moderate' },
  { to: '/admin/reports', label: 'Báo cáo', icon: Flag, permission: 'reports.read' },
  { to: '/admin/storage', label: 'Lưu trữ', icon: HardDrive, permission: 'storage.manage' },
  { to: '/admin/audit', label: 'Nhật ký', icon: Activity, permission: 'audit.read' },
  { to: '/admin/settings', label: 'Cài đặt', icon: SettingsIcon, permission: 'settings.manage' },
];

export function AdminLayout() {
  const { user } = useAuth();

  // The API does not send the permission list to the client, so the sidebar
  // gates on role. Role is a coarse proxy — an admin sees all sections, a
  // moderator sees the moderation ones — and the server decides what actually
  // works.
  const roles = user?.roles ?? [];
  const isAdmin = roles.includes('admin') || roles.includes('super_admin');
  const isModerator = roles.includes('moderator') || roles.includes('faculty_moderator');

  function maySee(permission: string): boolean {
    if (isAdmin) return true;
    if (!isModerator) return false;
    // Both are in the moderator tiers' permission set in
    // `backend/src/config/permissions.ts`. Leaving the queue out would have
    // given a moderator a reports screen and no way to approve the documents
    // the reports are about.
    return permission === 'reports.read' || permission === 'documents.moderate';
  }

  const visible = SECTIONS.filter((section) => maySee(section.permission));

  return (
    <div className="container-page flex gap-8 py-8">
      <aside className="hidden w-56 shrink-0 lg:block">
        <div className="sticky top-24">
          <div className="mb-4 flex items-center gap-2 px-3">
            <BarChart3 className="h-5 w-5 text-[var(--color-brand-600)]" aria-hidden />
            <h2 className="text-sm font-semibold">Quản trị</h2>
          </div>

          <nav aria-label="Điều hướng quản trị" className="space-y-0.5">
            {visible.map((section) => (
              <NavLink
                key={section.to}
                to={section.to}
                end={section.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-[var(--color-secondary)] text-[var(--color-foreground)]'
                      : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)]',
                  )
                }
              >
                <section.icon className="h-4 w-4" aria-hidden />
                {section.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </aside>

      {/* Horizontal scroller on narrow screens: a sidebar that collapses into a
          hamburger hides the section list behind a tap, and an administrator
          switching between sections repeatedly feels every one of them. */}
      <div className="min-w-0 flex-1">
        <nav
          aria-label="Điều hướng quản trị"
          className="-mx-4 mb-6 flex gap-1 overflow-x-auto px-4 pb-1 lg:hidden"
        >
          {visible.map((section) => (
            <NavLink
              key={section.to}
              to={section.to}
              end={section.end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium',
                  isActive
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                    : 'border-[var(--color-border)] text-[var(--color-muted-foreground)]',
                )
              }
            >
              <section.icon className="h-3.5 w-3.5" aria-hidden />
              {section.label}
            </NavLink>
          ))}
        </nav>

        <Outlet />
      </div>
    </div>
  );
}

/** Consistent page heading for every admin screen. */
export function AdminPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
