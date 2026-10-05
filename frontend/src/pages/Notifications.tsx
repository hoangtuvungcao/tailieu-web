import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, Button, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadCount,
  type Notification,
} from '@/lib/social-hooks';
import { cn, formatRelativeTime } from '@/lib/utils';

/**
 * Notifications.
 *
 * The API scopes the list to the recipient, so there is no "somebody else's
 * notifications" shape to request in the first place.
 *
 * What a row can say is deliberately narrow. The payload carries actor identity
 * and nothing else — no snapshot of the target's title — because a copy taken
 * at write time would keep announcing a document the recipient has since lost
 * access to. So the row states who did what kind of thing, and the target is
 * only ever resolved by following the link, where the server checks it again.
 *
 * That is also why some rows are not links at all. See `targetHref`.
 */

/**
 * Phrases that complete "<name> …".
 *
 * Anything not listed here falls through to `SYSTEM_PHRASES` rather than being
 * guessed at — a wrong sentence about why someone was notified is worse than a
 * vague one.
 */
const ACTOR_PHRASES: Record<string, string> = {
  post_like: 'đã thích bài viết của bạn',
  document_like: 'đã thích tài liệu của bạn',
  comment_like: 'đã thích bình luận của bạn',
  post_comment: 'đã bình luận về bài viết của bạn',
  document_comment: 'đã bình luận về tài liệu của bạn',
  comment_reply: 'đã trả lời bình luận của bạn',
  follow: 'đã theo dõi bạn',
};

/** Complete sentences, for kinds that are not "somebody did something to you". */
const SYSTEM_PHRASES: Record<string, string> = {
  rating_received: 'Bạn nhận được một đánh giá mới.',
  badge_awarded: 'Bạn vừa nhận được một huy hiệu.',
  collection_share: 'Một bộ sưu tập vừa được chia sẻ với bạn.',
  moderation: 'Nội dung của bạn đã được kiểm duyệt.',
  system: 'Thông báo từ hệ thống.',
};

/** The sentence a row shows. */
export function describe(notification: Notification): string {
  const phrase = ACTOR_PHRASES[notification.kind];

  if (phrase && notification.actorName) {
    // A collapsed row stands for many events: "A và 99 người khác đã thích…".
    const others = notification.aggregationCount - 1;
    return others > 0
      ? `${notification.actorName} và ${others} người khác ${phrase}`
      : `${notification.actorName} ${phrase}`;
  }

  return SYSTEM_PHRASES[notification.kind] ?? 'Bạn có một thông báo mới.';
}

/**
 * Where a notification leads.
 *
 * Every case here points at a page that exists. A `follow` used to return null,
 * because there was no public profile to send anyone to and a link to an
 * unrouted path 404s for whoever clicks it — so the row rendered without one
 * until `/users/:id` was built.
 */
export function targetHref(notification: Notification): string | null {
  if (!notification.targetId) return null;

  switch (notification.targetType) {
    case 'document':
      return `/documents/${notification.targetId}`;
    case 'post':
      return `/community/${notification.targetId}`;
    case 'collection':
      return `/collections/${notification.targetId}`;
    // A follow carries the actor as its target, which is exactly whose profile
    // the recipient wants to open.
    case 'user':
      return `/users/${notification.targetId}`;
    default:
      // An unknown kind stays unlinked rather than becoming `/undefined/...`.
      return null;
  }
}

export function NotificationsPage() {
  const [page, setPage] = useState(1);
  const query = useNotifications(page);
  // The true unread total, not a count of this page — the button must not
  // disappear because the unread rows happen to sit on an earlier page.
  //
  // `true` because this page is behind `RequireAuth`: it does not render until
  // a session exists. The gate still has to be passed rather than assumed — the
  // header's own call site is the one where the answer is genuinely unknown.
  const unread = useUnreadCount(true);
  const markAll = useMarkAllNotificationsRead();

  const notifications = query.data?.notifications ?? [];
  const meta = query.data?.meta;

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Thông báo</h1>
          {(unread.data?.unread ?? 0) > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              <CheckCheck className="h-4 w-4" aria-hidden />
              {markAll.isPending ? 'Đang đánh dấu…' : 'Đánh dấu tất cả đã đọc'}
            </Button>
          ) : null}
        </div>

        <div className="mt-6">
          {query.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="h-20 rounded-lg" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState
              message={
                query.error instanceof ApiError
                  ? query.error.message
                  : 'Đã xảy ra lỗi khi tải thông báo.'
              }
              onRetry={() => void query.refetch()}
            />
          ) : notifications.length === 0 ? (
            <EmptyState
              icon={<BellOff className="h-8 w-8" />}
              title="Chưa có thông báo nào"
              description="Khi có người thích, bình luận hoặc theo dõi bạn, thông báo sẽ xuất hiện ở đây."
            />
          ) : (
            <ul className="space-y-2">
              {notifications.map((notification) => (
                <NotificationRow key={notification.id} notification={notification} />
              ))}
            </ul>
          )}
        </div>

        {meta && meta.totalPages > 1 ? (
          <div className="mt-6 flex items-center justify-center gap-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              Trước
            </Button>
            <span className="text-sm text-[var(--color-muted-foreground)]">
              Trang {meta.page} / {meta.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= meta.totalPages}
              onClick={() => setPage((value) => value + 1)}
            >
              Sau
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NotificationRow({ notification }: { notification: Notification }) {
  const markRead = useMarkNotificationRead();
  const href = targetHref(notification);
  const isUnread = notification.readAt === null;

  // Marking read is fired on open rather than on render, so a page of
  // notifications does not silently clear the badge for someone who glanced at
  // the list and left.
  function mark() {
    if (isUnread) markRead.mutate(notification.id);
  }

  const body = (
    <>
      <span className="relative shrink-0">
        {notification.actorName ? (
          <Avatar name={notification.actorName} src={notification.actorAvatar} />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-muted)] text-[var(--color-muted-foreground)]">
            <Bell className="h-5 w-5" aria-hidden />
          </span>
        )}
        {isUnread ? (
          // A dot as well as the tinted background: the unread state must not
          // depend on colour alone.
          <span
            className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[var(--color-card)] bg-[var(--color-primary)]"
            title="Chưa đọc"
          />
        ) : null}
      </span>

      <span className="min-w-0 flex-1">
        <span className={cn('block text-sm', isUnread && 'font-medium')}>
          {describe(notification)}
        </span>
        <span className="mt-0.5 block text-xs text-[var(--color-muted-foreground)]">
          {formatRelativeTime(notification.createdAt)}
          {isUnread ? ' · Chưa đọc' : ''}
        </span>
      </span>
    </>
  );

  const className = cn(
    'flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors',
    isUnread
      ? 'border-[var(--color-primary)]/30 bg-[var(--color-muted)]/40'
      : 'border-[var(--color-border)] bg-[var(--color-card)]',
    href && 'hover:border-[var(--color-primary)]',
  );

  if (href) {
    return (
      <li>
        <Link to={href} className={className} onClick={mark}>
          {body}
        </Link>
      </li>
    );
  }

  // Nowhere to go — a system notification, or a follow with no profile page to
  // point at. Still a button, so it is keyboard reachable and still marks
  // itself read; it just does not navigate.
  return (
    <li>
      <button type="button" className={className} onClick={mark}>
        {body}
      </button>
    </li>
  );
}
