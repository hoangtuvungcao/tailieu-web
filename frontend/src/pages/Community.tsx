import { Heart, MessageSquare, Send, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Avatar, Badge, Button, Card, CardContent, EmptyState, ErrorState, Skeleton, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useCreatePost, useDeletePost, usePosts, useSetLike, type Post } from '@/lib/social-hooks';
import { cn, formatRelativeTime } from '@/lib/utils';

/**
 * Community feed.
 *
 * Deliberately minimal but not a mock: it reads real posts, creates real ones,
 * and likes through the real API. Every button either works or is absent —
 * there is no disabled placeholder for a feature that does not exist.
 *
 * Comments, collections and notifications are built on the server but have no
 * UI yet, so this page does not pretend to offer them.
 */

const VISIBILITY_LABELS: Record<string, string> = {
  public: 'Công khai',
  internal: 'Nội bộ',
  private: 'Riêng tư',
};

export function CommunityPage() {
  const { isAuthenticated } = useAuth();

  const [sort, setSort] = useState<'newest' | 'popular'>('newest');
  const [followingOnly, setFollowingOnly] = useState(false);
  const [page, setPage] = useState(1);

  const query = usePosts({
    sort,
    following: isAuthenticated ? followingOnly : false,
    page,
    limit: 15,
  });

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-bold tracking-tight">Cộng đồng</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Chia sẻ, hỏi đáp và thảo luận cùng sinh viên Đại học Tây Nguyên.
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
              { key: 'popular', label: 'Nổi bật' },
            ] as const).map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={sort === option.key}
                onClick={() => {
                  setSort(option.key);
                  setPage(1);
                }}
                className={cn(
                  'rounded px-3 py-1 text-xs font-medium',
                  sort === option.key
                    ? 'bg-[var(--color-secondary)]'
                    : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {isAuthenticated ? (
            <button
              type="button"
              aria-pressed={followingOnly}
              onClick={() => {
                setFollowingOnly((v) => !v);
                setPage(1);
              }}
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

        {query.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-32" />
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState
            message={query.error instanceof ApiError ? query.error.message : 'Không tải được bảng tin.'}
            onRetry={() => void query.refetch()}
          />
        ) : query.data?.posts.length === 0 ? (
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
            {query.data?.posts.map((post) => (
              <PostCard key={post.id} post={post} />
            ))}
          </div>
        )}

        {query.data && query.data.meta.totalPages > 1 ? (
          <nav className="mt-6 flex items-center justify-center gap-3" aria-label="Phân trang">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Trước
            </Button>
            <span className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
              {query.data.meta.page} / {query.data.meta.totalPages}
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

function PostCard({ post }: { post: Post }) {
  const { isAuthenticated, user } = useAuth();
  const setLike = useSetLike();
  const remove = useDeletePost();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isAuthor = user?.id === post.author.id;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <Avatar name={post.author.displayName} src={post.author.avatarUrl} size="sm" />

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{post.author.displayName}</p>
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
