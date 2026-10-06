import { Heart } from 'lucide-react';

import { useAuth } from '@/lib/auth';
import { useDocumentLikeState, useSetDocumentLike } from '@/lib/social-hooks';
import { cn } from '@/lib/utils';

/**
 * Like a document.
 *
 * The button was missing while everything behind it was built: the endpoint,
 * the counter, the reputation event and the `document_like` notification were
 * all in place and nothing ever called them. So a document's like count was
 * permanently zero, its owner could not earn reputation from it, and the
 * notification type was registered but never fired.
 *
 * State comes from the server rather than from props, for the reason
 * `BookmarkButton` gives: it cannot then disagree with itself across tabs.
 */
export function LikeButton({
  documentId,
  className,
  showLabel = true,
}: {
  documentId: string | undefined;
  className?: string;
  showLabel?: boolean;
}) {
  const { isAuthenticated } = useAuth();
  const state = useDocumentLikeState(documentId);
  const setLike = useSetDocumentLike();

  const liked = state.data?.liked ?? false;
  const count = state.data?.likeCount ?? 0;
  const label = liked ? 'Bỏ thích' : 'Thích';

  return (
    <button
      type="button"
      disabled={!isAuthenticated || !documentId || setLike.isPending}
      aria-pressed={liked}
      aria-label={label}
      // Explains the disabled state rather than leaving a dead control.
      title={isAuthenticated ? label : 'Đăng nhập để thích tài liệu'}
      onClick={() => {
        if (!documentId) return;
        void setLike.mutateAsync({ documentId, liked: !liked });
      }}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm disabled:opacity-50',
        liked
          ? 'text-[var(--color-destructive)]'
          : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
        className,
      )}
    >
      <Heart className={cn('h-4 w-4', liked && 'fill-current')} aria-hidden />
      {showLabel ? label : null}
      {/* Hidden at zero: a bare "0" beside a heart reads as a broken counter,
          and an unliked document with no likes is the normal case. */}
      {count > 0 ? <span className="tabular-nums">{count}</span> : null}
    </button>
  );
}
