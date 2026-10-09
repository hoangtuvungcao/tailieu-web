import { Heart, MessageSquare, Send, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, Badge, Button, Card, CardContent, EmptyState, ErrorState, Skeleton, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  useCreatePost,
  useDeletePost,
  useFeed,
  useForYou,
  useSetLike,
  useTrending,
  type Post,
} from '@/lib/social-hooks';
import { cn, formatRelativeTime } from '@/lib/utils';

/**
 * Community feed.
 *
 * Deliberately minimal but not a mock: it reads real posts, creates real ones,
 * and likes through the real API. Every button either works or is absent —
 * there is no disabled placeholder for a feature that does not exist.
 *
 * Paged by keyset cursor rather than by page number, because a feed is read
 * while it changes. With page numbers, a post published while somebody is
 * reading page 1 shifts every row down, so page 2 opens with a post they have
 * already seen and the one pushed past the boundary is never shown at all. The
 * server picks the mode from whether `page` is sent, and `useFeed` never
 * sends one.
 */

const VISIBILITY_LABELS: Record<string, string> = {
  public: 'Công khai',
  internal: 'Nội bộ',
  private: 'Riêng tư',
};

export function CommunityPage() {
  const { isAuthenticated } = useAuth();

  const [tab, setTab] = useState<'newest' | 'trending' | 'for-you'>('newest');
  const [followingOnly, setFollowingOnly] = useState(false);

  // Three rankings, three different questions. "Mới nhất" is cursor-walked —
  // no `page` is sent, which is what selects cursor mode server-side, and
  // changing a filter changes the query key so the walk restarts by itself.
  // The other two are short ranked lists rather than walks, so they are plain
  // queries.
  const newest = useFeed({
    following: isAuthenticated ? followingOnly : false,
    limit: 15,
  });
  const trending = useTrending(20);
  // Enabled only for the active tab, so opening the page fetches one ranking
  // rather than three. The endpoint 401s without an account, so this must
  // never be enabled while signed out.
  const forYou = useForYou(20, isAuthenticated && tab === 'for-you');

  const posts =
    tab === 'newest'
      ? (newest.data?.pages.flatMap((page) => page.posts) ?? [])
      : ((tab === 'trending' ? trending.data?.posts : forYou.data?.posts) ?? []);

  const isLoading =
    tab === 'newest' ? newest.isLoading : tab === 'trending' ? trending.isLoading : forYou.isLoading;
  const isError = tab === 'newest' ? newest.isError : tab === 'trending' ? trending.isError : forYou.isError;
  const error = tab === 'newest' ? newest.error : tab === 'trending' ? trending.error : forYou.error;

  function retry(): void {
    if (tab === 'newest') void newest.refetch();
    else if (tab === 'trending') void trending.refetch();
    else void forYou.refetch();
  }

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold tracking-tight">Cộng đồng</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Chia sẻ, hỏi đáp và thảo luận cùng cộng đồng sinh viên.
        </p>

        {isAuthenticated ? <Composer /> : (
          <Card className="mt-6">
            <CardContent className="p-5 text-center text-sm">
              <Link to="/login" className="text-[var(--color-primary)] hover:underline">
                Đăng nhập
              </Link>{' '}
              để đăng bài và bình luận.
            </CardContent>
          </Card>
        )}

        {/* One filter row above the list, not scattered around it. */}
        <div className="mt-6 mb-4 flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-[var(--color-border)] p-0.5">
            {([
              { key: 'newest', label: 'Mới nhất' },
              { key: 'trending', label: 'Nổi bật' },
              // Offered only when signed in — not hidden behind a 401. Every
              // term in the ranking needs a viewer.
              ...(isAuthenticated ? [{ key: 'for-you', label: 'Dành cho bạn' } as const] : []),
            ] as const).map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={tab === option.key}
                onClick={() => setTab(option.key)}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium',
                  tab === option.key
                    ? 'bg-[var(--color-secondary)]'
                    : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {isAuthenticated && tab === 'newest' ? (
            <button
              type="button"
              aria-pressed={followingOnly}
              onClick={() => setFollowingOnly((v) => !v)}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium',
                followingOnly
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                  : 'border-[var(--color-border)] text-[var(--color-muted-foreground)]',
              )}
            >
              <Users className="h-3.5 w-3.5" aria-hidden />
              Đang theo dõi
            </button>
          ) : null}
        </div>

        {tab === 'for-you' ? (
          // Said plainly, above the list. None of this is machine learning:
          // it is three readable terms — who you follow, your faculty, what is
          // trending — added together. Calling it personalised would promise
          // something it does not do.
          <p className="mb-3 text-xs text-[var(--color-muted-foreground)]">
            Xếp theo người bạn theo dõi, khoa của bạn và mức độ tương tác gần đây —
            một công thức đơn giản, không phải học máy.
          </p>
        ) : null}

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            message={error instanceof ApiError ? error.message : 'Không tải được bảng tin.'}
            onRetry={retry}
          />
        ) : posts.length === 0 ? (
          <EmptyState
            icon={<MessageSquare className="h-8 w-8" />}
            title={followingOnly ? 'Chưa có bài nào từ người bạn theo dõi' : 'Chưa có bài đăng nào'}
            description={
              followingOnly
                ? 'Theo dõi thêm người dùng để thấy bài của họ ở đây.'
                : 'Hãy là người đầu tiên chia sẻ điều gì đó.'
            }
          />
        ) : (
          <div className="space-y-3">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}

        {tab === 'newest' && newest.hasNextPage ? (
          <div className="mt-6 flex justify-center">
            <Button
              variant="outline"
              size="sm"
              isLoading={newest.isFetchingNextPage}
              onClick={() => void newest.fetchNextPage()}
            >
              Tải thêm
            </Button>
          </div>
        ) : null}

      </div>
    </div>
  );
}

function Composer() {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState('internal');
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePost();

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!body.trim()) return;

    setError(null);
    try {
      await create.mutateAsync({ body: body.trim(), visibility });
      setBody('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Không đăng được bài.');
    }
  }

  return (
    <Card className="mt-6">
      <CardContent className="p-4">
        <form onSubmit={submit} className="space-y-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Bạn đang nghĩ gì? Đặt câu hỏi, chia sẻ tài liệu, hoặc thông báo cho lớp…"
            aria-label="Nội dung bài đăng"
            maxLength={10_000}
          />

          {error ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">{error}</p>
          ) : null}

          <div className="flex items-center justify-between gap-2">
            <select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
              aria-label="Chế độ hiển thị"
              className="h-9 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-2.5 text-xs"
            >
              <option value="internal">Nội bộ</option>
              <option value="public">Công khai</option>
              <option value="private">Riêng tư</option>
            </select>

            <Button type="submit" size="sm" disabled={!body.trim()} isLoading={create.isPending}>
              <Send className="h-4 w-4" />
              Đăng
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Exported because the public profile renders the same card for the same posts.
 * A second copy would be a second place for "what a post card shows" — and,
 * more to the point, a second place to forget the visibility badge.
 */
export function PostCard({ post }: { post: Post }) {
  const { isAuthenticated, user } = useAuth();
  const setLike = useSetLike();
  const remove = useDeletePost();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isAuthor = user?.id === post.author.id;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          {/* Both the avatar and the name lead to the profile — the two things
              people actually click when they want to know who wrote this. */}
          <Link to={`/users/${post.author.id}`} className="shrink-0">
            <Avatar name={post.author.displayName} src={post.author.avatarUrl} size="sm" />
          </Link>

          <div className="min-w-0 flex-1">
            <Link
              to={`/users/${post.author.id}`}
              className="block truncate text-sm font-medium hover:text-[var(--color-primary)]"
            >
              {post.author.displayName}
            </Link>
            <p className="text-[11px] text-[var(--color-muted-foreground)]">
              {formatRelativeTime(post.createdAt)}
              {post.editedAt ? ' · đã sửa' : ''}
            </p>
          </div>

          {post.visibility !== 'internal' ? (
            <Badge variant="outline" className="shrink-0 text-[11px]">
              {VISIBILITY_LABELS[post.visibility] ?? post.visibility}
            </Badge>
          ) : null}
        </div>

        {/* A text node, never innerHTML — a post body is user input. */}
        <Link to={`/community/${post.id}`} className="block">
          <p className="whitespace-pre-wrap text-sm leading-relaxed hover:opacity-90">{post.body}</p>
        </Link>

        {post.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {post.tags.map((tag) => (
              <Badge key={tag.id} variant="outline" className="text-[11px]">{tag.name}</Badge>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            disabled={!isAuthenticated || setLike.isPending}
            aria-pressed={post.likedByViewer}
            aria-label={post.likedByViewer ? 'Bỏ thích' : 'Thích'}
            onClick={() =>
              void setLike.mutateAsync({ postId: post.id, liked: !post.likedByViewer })
            }
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs disabled:opacity-50',
              post.likedByViewer
                ? 'text-[var(--color-destructive)]'
                : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
            )}
          >
            <Heart className={cn('h-4 w-4', post.likedByViewer && 'fill-current')} aria-hidden />
            {post.stats.likes}
          </button>

          <Link
            to={`/community/${post.id}`}
            aria-label="Xem bài đăng và bình luận"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]"
          >
            <MessageSquare className="h-4 w-4" aria-hidden />
            {post.stats.comments}
          </Link>

          {isAuthor || post.permissions.canDelete ? (
            <div className="ml-auto">
              {confirmDelete ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    isLoading={remove.isPending}
                    onClick={() => void remove.mutateAsync(post.id)}
                  >
                    Xoá
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                    Huỷ
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Xoá bài đăng"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
