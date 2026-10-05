import { Search, ShieldCheck, ShieldOff, UserX } from 'lucide-react';
import { useState } from 'react';

import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import {
  useAdminUser,
  useAdminUsers,
  useForceLogout,
  useGrantRole,
  useRevokeRole,
  useRoles,
  useUpdateUser,
} from '@/lib/admin-hooks';
import { formatRelativeTime } from '@/lib/utils';
import { AdminPageHeader } from './AdminLayout';

/**
 * User administration.
 *
 * List on the left, detail in a dialog. A full page per user would mean losing
 * your place in a filtered list every time you act on someone — which, when
 * working through a queue of reports, is the whole job.
 */

const STATUS_LABELS: Record<string, string> = {
  active: 'Hoạt động',
  suspended: 'Tạm ngưng',
  deactivated: 'Vô hiệu',
};

const ROLE_LABELS: Record<string, string> = {
  student: 'Sinh viên',
  verified_student: 'SV đã xác minh',
  lecturer: 'Giảng viên',
  faculty_moderator: 'KĐV khoa',
  moderator: 'Kiểm duyệt viên',
  admin: 'Quản trị viên',
  super_admin: 'Quản trị tối cao',
};

export function AdminUsersPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('');
  const [role, setRole] = useState<string>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);

  const query = useAdminUsers({
    q: search || undefined,
    status: status || undefined,
    role: role || undefined,
    page,
    limit: 25,
  });

  return (
    <>
      <AdminPageHeader
        title="Người dùng"
        description="Tìm kiếm, xem vai trò, đình chỉ và đăng xuất cưỡng bức."
      />

      {/* One filter row above the table, per the interaction spec. */}
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Tìm theo tên hoặc email…"
            aria-label="Tìm người dùng"
            className="pl-10"
          />
        </div>

        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
          aria-label="Lọc theo trạng thái"
          className="h-10 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
        >
          <option value="">Mọi trạng thái</option>
          <option value="active">Hoạt động</option>
          <option value="suspended">Tạm ngưng</option>
          <option value="deactivated">Vô hiệu</option>
        </select>

        <select
          value={role}
          onChange={(event) => {
            setRole(event.target.value);
            setPage(1);
          }}
          aria-label="Lọc theo vai trò"
          className="h-10 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
        >
          <option value="">Mọi vai trò</option>
          {Object.entries(ROLE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-14" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof ApiError ? query.error.message : 'Không tải được.'}
          onRetry={() => void query.refetch()}
        />
      ) : query.data?.users.length === 0 ? (
        <EmptyState
          icon={<Search className="h-8 w-8" />}
          title="Không tìm thấy người dùng nào"
          description="Thử từ khoá khác hoặc bỏ bộ lọc."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            {/* A table, not cards: comparing status and roles across rows is
                the task, and a grid of cards makes column comparison impossible. */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted-foreground)]">
                    <th className="px-4 py-2 font-medium">Người dùng</th>
                    <th className="px-4 py-2 font-medium">Vai trò</th>
                    <th className="px-4 py-2 font-medium">Trạng thái</th>
                    <th className="px-4 py-2 font-medium">Đăng nhập gần nhất</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {query.data?.users.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-[var(--color-border)] last:border-0"
                    >
                      <td className="px-4 py-2.5">
                        <p className="font-medium">{user.displayName}</p>
                        <p className="text-xs text-[var(--color-muted-foreground)]">{user.email}</p>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {user.roleKeys.map((key) => (
                            <Badge key={key} variant="outline" className="text-[11px]">
                              {ROLE_LABELS[key] ?? key}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge
                          variant={
                            user.status === 'active'
                              ? 'success'
                              : user.status === 'suspended'
                                ? 'warning'
                                : 'destructive'
                          }
                        >
                          {STATUS_LABELS[user.status] ?? user.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-[var(--color-muted-foreground)]">
                        {user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : 'Chưa bao giờ'}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setSelected(user.id)}
                        >
                          Chi tiết
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {query.data && query.data.meta.totalPages > 1 ? (
        <nav className="mt-4 flex items-center justify-center gap-3" aria-label="Phân trang">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Trước
          </Button>
          <span className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
            Trang {query.data.meta.page} / {query.data.meta.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= query.data.meta.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Sau
          </Button>
        </nav>
      ) : null}

      {selected ? <UserDetailPanel userId={selected} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

/**
 * User detail.
 *
 * Every action here is destructive or privilege-affecting, so each is a
 * deliberate button rather than a toggle — a mis-click on "suspend" would sign
 * someone out of every device immediately.
 */
function UserDetailPanel({ userId, onClose }: { userId: string; onClose: () => void }) {
  const detail = useAdminUser(userId);
  const roles = useRoles();
  const updateUser = useUpdateUser();
  const grantRole = useGrantRole();
  const revokeRole = useRevokeRole();
  const forceLogout = useForceLogout();

  const [roleToGrant, setRoleToGrant] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Thao tác thất bại.');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-lg overflow-y-auto bg-[var(--color-background)] p-6"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Chi tiết người dùng"
      >
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-lg font-semibold">Chi tiết người dùng</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Đóng
          </Button>
        </div>

        {detail.isLoading ? (
          <Skeleton className="h-64" />
        ) : detail.isError || !detail.data ? (
          <ErrorState message="Không tải được người dùng." />
        ) : (
          <div className="space-y-5">
            {error ? (
              <p role="alert" className="rounded-md border border-[var(--color-destructive)]/30 bg-[color-mix(in_oklch,var(--color-destructive)_6%,transparent)] px-3 py-2 text-sm text-[var(--color-destructive)]">
                {error}
              </p>
            ) : null}

            <div>
              <p className="font-medium">{detail.data.displayName}</p>
              <p className="text-sm text-[var(--color-muted-foreground)]">{detail.data.email}</p>
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                Tham gia {formatRelativeTime(detail.data.createdAt)} ·{' '}
                {detail.data.activeSessions} phiên đang mở
              </p>
            </div>

            {/* --- Roles --- */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Vai trò</h3>
              <div className="space-y-1.5">
                {detail.data.roles.map((role) => (
                  <div
                    key={role.id}
                    className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2"
                  >
                    <div>
                      <p className="text-sm">{role.roleName}</p>
                      {role.facultyId ? (
                        <p className="text-[11px] text-[var(--color-muted-foreground)]">
                          Giới hạn theo một khoa
                        </p>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      isLoading={revokeRole.isPending}
                      onClick={() =>
                        void act(() => revokeRole.mutateAsync({ id: userId, roleId: role.id }))
                      }
                    >
                      <ShieldOff className="h-4 w-4" />
                      Thu hồi
                    </Button>
                  </div>
                ))}
              </div>

              <div className="mt-2 flex gap-2">
                <select
                  value={roleToGrant}
                  onChange={(event) => setRoleToGrant(event.target.value)}
                  aria-label="Chọn vai trò để cấp"
                  className="h-9 flex-1 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
                >
                  <option value="">Chọn vai trò…</option>
                  {(roles.data ?? [])
                    // `super_admin` is omitted deliberately: the API refuses to
                    // grant it, so offering it would be a button that always fails.
                    .filter((role) => role.key !== 'super_admin')
                    .map((role) => (
                      <option key={role.id} value={role.key}>
                        {role.name}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  disabled={!roleToGrant}
                  isLoading={grantRole.isPending}
                  onClick={() =>
                    void act(async () => {
                      await grantRole.mutateAsync({ id: userId, roleKey: roleToGrant });
                      setRoleToGrant('');
                    })
                  }
                >
                  <ShieldCheck className="h-4 w-4" />
                  Cấp
                </Button>
              </div>
            </section>

            {/* --- Account state --- */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Trạng thái tài khoản</h3>
              <div className="flex flex-wrap gap-2">
                {detail.data.status === 'active' ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    isLoading={updateUser.isPending}
                    onClick={() =>
                      void act(() =>
                        updateUser.mutateAsync({
                          id: userId,
                          status: 'suspended',
                          reason: 'Suspended from the admin panel',
                        }),
                      )
                    }
                  >
                    <UserX className="h-4 w-4" />
                    Tạm ngưng
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    isLoading={updateUser.isPending}
                    onClick={() =>
                      void act(() => updateUser.mutateAsync({ id: userId, status: 'active' }))
                    }
                  >
                    Kích hoạt lại
                  </Button>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  isLoading={forceLogout.isPending}
                  onClick={() => void act(() => forceLogout.mutateAsync(userId))}
                >
                  Đăng xuất mọi thiết bị
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-[var(--color-muted-foreground)]">
                Tạm ngưng sẽ thu hồi toàn bộ phiên và vô hiệu hoá token hiện hành ngay lập tức.
              </p>
            </section>

            {/* --- Sessions --- */}
            <section>
              <h3 className="mb-2 text-sm font-semibold">Phiên gần đây</h3>
              <div className="space-y-1">
                {detail.data.sessions.length === 0 ? (
                  <p className="text-sm text-[var(--color-muted-foreground)]">Chưa có phiên nào.</p>
                ) : (
                  detail.data.sessions.slice(0, 10).map((session) => (
                    <div
                      key={session.id}
                      className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="truncate">
                          {session.userAgent?.slice(0, 60) ?? 'Thiết bị không xác định'}
                        </p>
                        <p className="text-[var(--color-muted-foreground)]">
                          {session.ip ?? '—'} · {formatRelativeTime(session.lastUsedAt)}
                        </p>
                      </div>
                      <Badge variant={session.active ? 'success' : 'outline'}>
                        {session.active ? 'Đang mở' : session.revokedReason ?? 'Đã đóng'}
                      </Badge>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
