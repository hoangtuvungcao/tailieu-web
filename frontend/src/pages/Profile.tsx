import {
  Award,
  BookOpen,
  CalendarDays,
  FileText,
  Heart,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Star,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { FollowButton } from '@/components/FollowButton';
import { Avatar, Button, Card, CardContent, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useFollowers, useFollowing, usePosts, useProfile } from '@/lib/social-hooks';
import { cn, formatDate } from '@/lib/utils';
import { PostCard } from '@/pages/Community';

/**
 * A public profile.
 *
 * Everything the viewer is not allowed to see is already absent from the
 * response — the post and document counts come from the server computed with
 * this viewer's own predicate, so the numbers above the lists match the lists.
 * An account that asked to be erased has no profile at all and answers 404.
 *
 * The posts are rendered with the same `PostCard` the community feed uses. A
 * second card component would be a second place for the visibility badge to be
 * forgotten.
 */
/** Badge `icon` strings from the seed, mapped to the icons they name. */
const BADGE_ICONS: Record<string, typeof Award> = {
  sparkles: Sparkles,
  'book-open': BookOpen,
  'shield-check': ShieldCheck,
  award: Award,
  heart: Heart,
};

export function ProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'posts' | 'followers' | 'following'>('posts');

  const profile = useProfile(id);
  const posts = usePosts({ authorUserId: id, page, limit: 10 });
  // Enabled per tab, so opening a profile fetches one list rather than three.
  const followers = useFollowers(id, 1, tab === 'followers');
  const following = useFollowing(id, 1, tab === 'following');

  if (profile.isLoading) {
    return (
      <div className="container-page py-8">
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-40 rounded-lg" />
          <Skeleton className="h-32 rounded-lg" />
        </div>
      </div>
    );
  }

  if (profile.isError || !profile.data) {
    const error = profile.error;
    // 404 covers both "no such account" and "this account was erased". The
    // wording does not pretend to know which.
    const notFound = error instanceof ApiError && error.status === 404;

    return (
      <div className="container-page py-8">
        <div className="mx-auto max-w-3xl">
          <ErrorState
            message={
              notFound
                ? 'Không tìm thấy người dùng này.'
                : error instanceof ApiError
                  ? error.message
                  : 'Đã xảy ra lỗi khi tải hồ sơ.'
            }
            onRetry={notFound ? undefined : () => void profile.refetch()}
          />
        </div>
      </div>
    );
  }

  const user = profile.data;
  const postList = posts.data?.posts ?? [];
  const meta = posts.data?.meta;

  const affiliation = [
    user.faculty?.name,
    user.program?.name,
    user.enrollmentYear ? `K.${user.enrollmentYear}` : null,
  ].filter(Boolean);

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-3xl">
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-wrap items-start gap-4">
              <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />

              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-bold tracking-tight">{user.displayName}</h1>
                {user.username ? (
                  <p className="text-sm text-[var(--color-muted-foreground)]">@{user.username}</p>
                ) : null}

                {user.bio ? (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{user.bio}</p>
                ) : null}

                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-muted-foreground)]">
                  {affiliation.length > 0 ? <span>{affiliation.join(' · ')}</span> : null}
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                    Tham gia {formatDate(user.joinedAt)}
                  </span>
                  {/* A penalised account can be below zero, so the wording says
                      "uy tín" (standing) rather than framing it as a score that
                      only ever goes up. */}
                  <span className="inline-flex items-center gap-1 font-medium text-[var(--color-foreground)]">
                    <Star className="h-3.5 w-3.5" aria-hidden />
                    {user.reputation} uy tín
                  </span>
                </p>

                {user.badges.length > 0 ? (
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {user.badges.map((badge) => {
                      const Icon = BADGE_ICONS[badge.icon ?? ''] ?? Award;
                      return (
                        <li key={badge.code}>
                          <span
                            className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs"
                            // The description is the criteria, which is the
                            // only thing that explains why somebody has this.
                            title={badge.description ?? badge.name}
                          >
                            <Icon className="h-3.5 w-3.5" aria-hidden />
                            {badge.name}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>

              <FollowButton userId={user.id} />
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat
                icon={<MessageSquare className="h-4 w-4" />}
                label="Bài đăng"
                value={user.stats.posts}
              />
              <Stat
                icon={<FileText className="h-4 w-4" />}
                label="Tài liệu"
                value={user.stats.documents}
                // Only meaningful as a link when there is something behind it.
                to={user.stats.documents > 0 ? `/documents?ownerUserId=${user.id}` : undefined}
              />
              <Stat
                icon={<Users className="h-4 w-4" />}
                label="Người theo dõi"
                value={user.stats.followers}
              />
              <Stat
                icon={<Users className="h-4 w-4" />}
                label="Đang theo dõi"
                value={user.stats.following}
              />
            </div>
          </CardContent>
        </Card>

        <div className="mt-8 flex gap-1 border-b border-[var(--color-border)]">
          {(
            [
              { key: 'posts', label: `Bài đăng (${user.stats.posts})` },
              { key: 'followers', label: `Người theo dõi (${user.stats.followers})` },
              { key: 'following', label: `Đang theo dõi (${user.stats.following})` },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={tab === option.key}
              onClick={() => setTab(option.key)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
                tab === option.key
                  ? 'border-[var(--color-primary)] text-[var(--color-foreground)]'
                  : 'border-transparent text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === 'posts' ? (
            <>
              <p className="mb-3 text-sm text-[var(--color-muted-foreground)]">
                {user.isSelf
                  ? 'Bài đăng của bạn, kể cả bài riêng tư.'
                  : 'Những bài bạn được phép xem.'}
              </p>

              {posts.isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }, (_, index) => (
                    <Skeleton key={index} className="h-32 rounded-lg" />
                  ))}
                </div>
              ) : posts.isError ? (
                <ErrorState
                  message={
                    posts.error instanceof ApiError
                      ? posts.error.message
                      : 'Đã xảy ra lỗi khi tải bài đăng.'
                  }
                  onRetry={() => void posts.refetch()}
                />
              ) : postList.length === 0 ? (
                <EmptyState
                  icon={<MessageSquare className="h-8 w-8" />}
                  title="Chưa có bài đăng nào"
                  description={
                    user.isSelf
                      ? 'Bài bạn đăng trong Cộng đồng sẽ xuất hiện ở đây.'
                      : 'Người này chưa đăng bài nào bạn có thể xem.'
                  }
                />
              ) : (
                <div className="space-y-3">
                  {postList.map((post) => (
                    <PostCard key={post.id} post={post} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <UserList
              query={tab === 'followers' ? followers : following}
              emptyTitle={tab === 'followers' ? 'Chưa có người theo dõi' : 'Chưa theo dõi ai'}
              emptyDescription={
                tab === 'followers'
                  ? 'Khi có người theo dõi, họ sẽ xuất hiện ở đây.'
                  : 'Những tài khoản người này theo dõi sẽ xuất hiện ở đây.'
              }
            />
          )}
        </div>

        {tab === 'posts' && meta && meta.totalPages > 1 ? (
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

function Stat({
  icon,
  label,
  value,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  to?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
        {icon}
        {label}
      </span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
    </>
  );

  const className =
    'flex flex-col gap-0.5 rounded-lg border border-[var(--color-border)] p-3';

  if (!to) {
    return <div className={className}>{body}</div>;
  }

  return (
    <Link to={to} className={`${className} hover:border-[var(--color-primary)]`}>
      {body}
    </Link>
  );
}

/** Whatever `useFollowers` returns — spelled once rather than restated. */
type FollowListQuery = ReturnType<typeof useFollowers>;

/**
 * A page of followers or following.
 *
 * Deliberately no follow button on each row. The list endpoint returns *users*,
 * not relationships, so a button per row would be one request per row — thirty
 * for a full page — to answer a question most visitors never asked. The row
 * links to the profile, where the button already knows the answer.
 */
function UserList({
  query,
  emptyTitle,
  emptyDescription,
}: {
  query: FollowListQuery;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (query.isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        message={query.error instanceof ApiError ? query.error.message : 'Đã xảy ra lỗi.'}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const users = query.data?.users ?? [];

  if (users.length === 0) {
    return (
      <EmptyState
        icon={<Users className="h-8 w-8" />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  return (
    <ul className="space-y-2">
      {users.map((entry) => (
        <li key={entry.id}>
          <Link
            to={`/users/${entry.id}`}
            className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] p-3 transition-colors hover:border-[var(--color-primary)]"
          >
            <Avatar name={entry.displayName} src={entry.avatarUrl} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{entry.displayName}</span>
              {entry.bio ? (
                <span className="mt-0.5 line-clamp-2 block text-xs text-[var(--color-muted-foreground)]">
                  {entry.bio}
                </span>
              ) : null}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
