import { ArrowLeft, Flag, Heart, MessageSquare, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { BookmarkButton } from '@/components/BookmarkButton';
import { ReportDialog } from '@/components/ReportDialog';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { useSeo } from '@/lib/seo';
import {
  useComments,
  useCreateComment,
  useDeleteComment,
  useDeletePost,
  usePost,
  useSetCommentLike,
  useSetLike,
  type Comment,
  type Post,
} from '@/lib/social-hooks';
import { cn, formatRelativeTime } from '@/lib/utils';

/**
 * Post detail with its comment thread.
 *
 * This page is the reason the comments API is not dead code. The feed shows a
 * comment *count*; here that count becomes the conversation.
 *
 * The server returns one flat page already grouped — top-level comments each
 * carrying their `replies` — so the thread renders from a single request rather
 * than one per comment. Replies are capped at depth 3 in the database, and this
 * renderer mirrors that: past one level of indentation the nesting stops
 * growing, because a deeper tree is unreadable on a phone long before it is
 * unrenderable.
 */

const VISIBILITY_LABELS: Record<string, string> = {
  public: 'Công khai',
  internal: 'Nội bộ',
  private: 'Riêng tư',
};

/**
 * The first line of a post, trimmed to a length that fits a search result.
 *
 * A post has no summary field, and its body may be a paragraph of prose or a
 * screenshot's caption. The first line is the closest thing to a title it has,
 * and cutting at a newline first means a multi-line post is not truncated
 * mid-sentence when it did not need to be.
 */
function firstLine(body: string, max = 80): string {
  const line = body.split('\n').find((entry) => entry.trim() !== '') ?? body;
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

export function PostDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const post = usePost(id);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A post's body is free text, so only its first line becomes the description
  // — a preview card wants a sentence, and the API returns the whole post.
  const postData = post.data;
  useSeo({
    title: postData
      ? `${postData.title ?? firstLine(postData.body)} — TAILIEU TTN`
      : 'Bài đăng — TAILIEU TTN',
    description: postData ? firstLine(postData.body, 160) : undefined,
    type: 'article',
    jsonLd: postData
      ? {
          '@context': 'https://schema.org',
          '@type': 'DiscussionForumPosting',
          headline: postData.title ?? firstLine(postData.body),
          text: firstLine(postData.body, 300),
          datePublished: postData.createdAt,
          author: { '@type': 'Person', name: postData.author.displayName },
        }
      : null,
  });

  if (post.isLoading) {
    return (
      <div className="container-page py-8">
        <div className="mx-auto max-w-2xl space-y-4">
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (post.isError || !post.data) {
    // A private post the viewer may not read is a 404, not a 403 — the API
    // deliberately does not confirm that a post they cannot see exists.
    const notFound = post.error instanceof ApiError && post.error.status === 404;

    return (
      <div className="container-page py-8">
        <div className="mx-auto max-w-2xl">
          {notFound ? (
            <EmptyState
              icon={<MessageSquare className="h-8 w-8" aria-hidden />}
              title="Không tìm thấy bài đăng"
              description="Bài đăng không tồn tại, đã bị xoá, hoặc bạn không có quyền xem."
              action={
                <Button variant="outline" onClick={() => void navigate('/community')}>
                  Về trang cộng đồng
                </Button>
              }
            />
          ) : (
            <ErrorState
              message="Không tải được bài đăng."
              onRetry={() => void post.refetch()}
            />
          )}
        </div>
      </div>
    );
  }

  const data = post.data;

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-2xl space-y-4">
        <Link
          to="/community"
          className="inline-flex items-center gap-1.5 text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Cộng đồng
        </Link>

        <Card>
          <CardContent className="space-y-4 p-5">
            <div className="flex items-start gap-3">
              <Link to={`/users/${data.author.id}`} className="shrink-0">
                <Avatar name={data.author.displayName} src={data.author.avatarUrl} />
              </Link>

              <div className="min-w-0 flex-1">
                <Link
                  to={`/users/${data.author.id}`}
                  className="block truncate font-medium hover:text-[var(--color-primary)]"
                >
                  {data.author.displayName}
                </Link>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {formatRelativeTime(data.createdAt)}
                  {data.editedAt ? ' · đã sửa' : ''}
                </p>
              </div>

              {data.visibility !== 'internal' ? (
                <Badge variant="outline" className="shrink-0 text-[11px]">
                  {VISIBILITY_LABELS[data.visibility] ?? data.visibility}
                </Badge>
              ) : null}
            </div>

            {data.title ? <h1 className="text-xl font-semibold">{data.title}</h1> : null}

            {/* A text node, never innerHTML — a post body is user input. */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.body}</p>

            {data.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {data.tags.map((tag) => (
                  <Badge key={tag.id} variant="outline" className="text-[11px]">
                    {tag.name}
                  </Badge>
                ))}
              </div>
            ) : null}

            <PostActions
              post={data}
              onDeleted={() => void navigate('/community')}
              confirmDelete={confirmDelete}
              setConfirmDelete={setConfirmDelete}
            />
          </CardContent>
        </Card>

        <CommentSection postId={data.id} commentCount={data.stats.comments} />
      </div>
    </div>
  );
}

function PostActions({
  post,
  onDeleted,
  confirmDelete,
  setConfirmDelete,
}: {
  post: Post;
  onDeleted: () => void;
  confirmDelete: boolean;
  setConfirmDelete: (value: boolean) => void;
}) {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const setLike = useSetLike();
  const remove = useDeletePost();
  const [reportOpen, setReportOpen] = useState(false);

  const canDelete = post.permissions.canDelete;

  return (
    <div className="flex items-center gap-3 border-t border-[var(--color-border)] pt-3">
      <button
        type="button"
        disabled={!isAuthenticated || setLike.isPending}
        aria-pressed={post.likedByViewer}
        aria-label={post.likedByViewer ? 'Bỏ thích' : 'Thích'}
        onClick={() => void setLike.mutateAsync({ postId: post.id, liked: !post.likedByViewer })}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm disabled:opacity-50',
          post.likedByViewer
            ? 'text-[var(--color-destructive)]'
            : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
        )}
      >
        <Heart className={cn('h-4 w-4', post.likedByViewer && 'fill-current')} aria-hidden />
        {post.stats.likes}
      </button>

      <span className="flex items-center gap-1.5 px-2 py-1 text-sm text-[var(--color-muted-foreground)]">
        <MessageSquare className="h-4 w-4" aria-hidden />
        {post.stats.comments}
      </span>

      <BookmarkButton target="post" id={post.id} />

      {user?.id !== post.author.id ? (
        <Button
          variant="outline"
          size="sm"
          aria-label="Báo cáo bài đăng"
          className="gap-1.5 text-xs text-[var(--color-destructive)] border-[var(--color-destructive)]/30 hover:bg-[color-mix(in_oklch,var(--color-destructive)_8%,transparent)]"
          onClick={() => {
            if (!isAuthenticated) {
              navigate('/login');
            } else {
              setReportOpen(true);
            }
          }}
        >
          <Flag className="h-3.5 w-3.5" aria-hidden />
          Báo cáo
        </Button>
      ) : null}

      {canDelete ? (
        <div className="ml-auto">
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <Button
                variant="destructive"
                size="sm"
                isLoading={remove.isPending}
                onClick={() => void remove.mutateAsync(post.id).then(onDeleted)}
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

      {reportOpen ? (
        <ReportDialog
          targetType="post"
          targetId={post.id}
          targetTitle={post.title || post.body.slice(0, 60)}
          onClose={() => setReportOpen(false)}
        />
      ) : null}
    </div>
  );
}

function CommentSection({ postId, commentCount }: { postId: string; commentCount: number }) {
  const { isAuthenticated } = useAuth();
  const comments = useComments('post', postId);

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          Bình luận
          <span className="text-sm font-normal text-[var(--color-muted-foreground)]">
            {commentCount}
          </span>
        </h2>

        {isAuthenticated ? (
          <CommentComposer targetType="post" targetId={postId} />
        ) : (
          <p className="rounded-lg bg-[var(--color-muted)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
            <Link to="/login" className="text-[var(--color-primary)] hover:underline">
              Đăng nhập
            </Link>{' '}
            để bình luận.
          </p>
        )}

        {comments.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : comments.isError ? (
          <ErrorState
            message="Không tải được bình luận."
            onRetry={() => void comments.refetch()}
          />
        ) : comments.data && comments.data.comments.length > 0 ? (
          <ul className="space-y-4">
            {comments.data.comments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                targetType="post"
                targetId={postId}
              />
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-[var(--color-muted-foreground)]">
            Chưa có bình luận nào. Hãy là người đầu tiên.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function CommentComposer({
  targetType,
  targetId,
  parentCommentId = null,
  onDone,
  autoFocus = false,
}: {
  targetType: 'post' | 'document';
  targetId: string;
  parentCommentId?: string | null;
  onDone?: () => void;
  autoFocus?: boolean;
}) {
  const [body, setBody] = useState('');
  const create = useCreateComment();

  const error =
    create.error instanceof ApiError ? create.error.message : create.error ? 'Không gửi được bình luận.' : null;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;

    try {
      await create.mutateAsync({ targetType, targetId, body: trimmed, parentCommentId });
      setBody('');
      onDone?.();
    } catch {
      // The message is rendered from `create.error` below; the body is left
      // intact so a failed send does not destroy what the person typed.
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={parentCommentId ? 'Viết trả lời...' : 'Viết bình luận...'}
        rows={parentCommentId ? 2 : 3}
        maxLength={5000}
        autoFocus={autoFocus}
        aria-label={parentCommentId ? 'Nội dung trả lời' : 'Nội dung bình luận'}
        disabled={create.isPending}
      />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" isLoading={create.isPending} disabled={!body.trim()}>
          <Send className="h-3.5 w-3.5" aria-hidden />
          {parentCommentId ? 'Trả lời' : 'Bình luận'}
        </Button>

        {onDone ? (
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Huỷ
          </Button>
        ) : null}

        {error ? (
          <span role="alert" className="text-xs text-[var(--color-destructive)]">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function CommentItem({
  comment,
  targetType,
  targetId,
  isReply = false,
}: {
  comment: Comment;
  targetType: 'post' | 'document';
  targetId: string;
  isReply?: boolean;
}) {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const setLike = useSetCommentLike();
  const remove = useDeleteComment();
  const [replying, setReplying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const replies = comment.replies ?? [];

  // A removed comment keeps its place so the replies under it stay reachable.
  // Rendering it as nothing would make a live conversation look like it was
  // answering no one.
  if (comment.deleted) {
    return (
      <li className={cn('space-y-3', isReply && 'border-l-2 border-[var(--color-border)] pl-3')}>
        <div className="flex items-start gap-2.5">
          <div className="h-8 w-8 shrink-0 rounded-full border border-dashed border-[var(--color-border)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm italic text-[var(--color-muted-foreground)]">
              Bình luận đã bị xoá
            </p>
            {comment.stats.replies > 0 ? (
              <p className="text-[11px] text-[var(--color-muted-foreground)]">
                {comment.stats.replies} trả lời
              </p>
            ) : null}
          </div>
        </div>

        {replies.length > 0 ? (
          <ul className="space-y-4 pl-4 sm:pl-9">
            {replies.map((reply) => (
              <CommentItem
                key={reply.id}
                comment={reply}
                targetType={targetType}
                targetId={targetId}
                isReply
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }

  return (
    <li className={cn('space-y-3', isReply && 'border-l-2 border-[var(--color-border)] pl-3')}>
      <div className="flex items-start gap-2.5">
        {/* Safe to link: the `deleted` branch above returns early, and that is
            the only case where the API withholds `author.id`. */}
        <Link to={`/users/${comment.author.id}`} className="shrink-0">
          <Avatar name={comment.author.displayName} src={comment.author.avatarUrl} size="sm" />
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Link
              to={`/users/${comment.author.id}`}
              className="truncate text-sm font-medium hover:text-[var(--color-primary)]"
            >
              {comment.author.displayName}
            </Link>
            <span className="text-[11px] text-[var(--color-muted-foreground)]">
              {formatRelativeTime(comment.createdAt)}
              {comment.editedAt ? ' · đã sửa' : ''}
            </span>
          </div>

          <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">{comment.body}</p>

          <div className="mt-1.5 flex items-center gap-1">
            <button
              type="button"
              disabled={!isAuthenticated || setLike.isPending}
              aria-pressed={comment.likedByViewer}
              aria-label={comment.likedByViewer ? 'Bỏ thích bình luận' : 'Thích bình luận'}
              onClick={() =>
                void setLike.mutateAsync({
                  commentId: comment.id,
                  liked: !comment.likedByViewer,
                })
              }
              className={cn(
                'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs disabled:opacity-50',
                comment.likedByViewer
                  ? 'text-[var(--color-destructive)]'
                  : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
              )}
            >
              <Heart
                className={cn('h-3.5 w-3.5', comment.likedByViewer && 'fill-current')}
                aria-hidden
              />
              {comment.stats.likes}
            </button>

            {/* Replies are capped at depth 3 server-side, so the reply box is
                offered only where a reply can actually be accepted. */}
            {isAuthenticated && comment.depth < 3 ? (
              <button
                type="button"
                onClick={() => setReplying((value) => !value)}
                className="rounded px-1.5 py-0.5 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]"
              >
                Trả lời
              </button>
            ) : null}

            {comment.permissions.canDelete ? (
              <div className="ml-1">
                {confirmDelete ? (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={remove.isPending}
                      onClick={() =>
                        void remove.mutateAsync({
                          commentId: comment.id,
                          targetType,
                          targetId,
                        })
                      }
                      className="rounded px-1.5 py-0.5 text-xs text-[var(--color-destructive)] hover:bg-[var(--color-muted)] disabled:opacity-50"
                    >
                      Xoá
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      className="rounded px-1.5 py-0.5 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]"
                    >
                      Huỷ
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label="Xoá bình luận"
                    onClick={() => setConfirmDelete(true)}
                    className="rounded px-1.5 py-0.5 text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            ) : null}

            {user?.id !== comment.author.id ? (
              <button
                type="button"
                aria-label="Báo cáo bình luận"
                onClick={() => {
                  if (!isAuthenticated) {
                    navigate('/login');
                  } else {
                    setReportOpen(true);
                  }
                }}
                className="rounded px-1.5 py-0.5 text-xs text-[var(--color-destructive)] hover:bg-[color-mix(in_oklch,var(--color-destructive)_8%,transparent)]"
              >
                <Flag className="mr-1 inline h-3 w-3" aria-hidden />
                Báo cáo
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Indentation is the thread's only depth cue, but 36px per level is a
          desktop measure: a depth-3 reply on a 360px phone would spend 72px of
          a ~328px column on whitespace and leave the body in a sliver. The
          indent halves below `sm`, where it still reads as nested. */}
      {replying ? (
        <div className="pl-4 sm:pl-9">
          <CommentComposer
            targetType={targetType}
            targetId={targetId}
            parentCommentId={comment.id}
            onDone={() => setReplying(false)}
            autoFocus
          />
        </div>
      ) : null}

      {replies.length > 0 ? (
        <ul className="space-y-4 pl-9">
          {replies.map((reply) => (
            <CommentItem
              key={reply.id}
              comment={reply}
              targetType={targetType}
              targetId={targetId}
              isReply
            />
          ))}
        </ul>
      ) : null}

      {reportOpen ? (
        <ReportDialog
          targetType="comment"
          targetId={comment.id}
          targetTitle={comment.body.slice(0, 60)}
          onClose={() => setReportOpen(false)}
        />
      ) : null}
    </li>
  );
}
