import { Bookmark as BookmarkIcon } from 'lucide-react';

import { useAuth } from '@/lib/auth';
import { useBookmarkState, useSetBookmark } from '@/lib/social-hooks';
import { cn } from '@/lib/utils';

/**
 * Save or unsave something.
 *
 * The saved state is read from the server rather than passed in from a parent's
 * props. That costs one small request per page, and buys the property that
 * matters: the button cannot disagree with the bookmarks page about what is
 * saved, including when the change was made in another tab.
 *
 * The endpoint behind this is deliberately public — it answers
 * `{ bookmarked: false }` to a signed-out caller — so the query is safe to run
 * before we know whether anyone is signed in.
 */
export function BookmarkButton({
  target,
  id,
  className,
  showLabel = true,
}: {
  target: 'document' | 'post' | 'collection';
  id: string | undefined;
  className?: string;
  showLabel?: boolean;
}) {
  const { isAuthenticated } = useAuth();
  const state = useBookmarkState(target, id);
  const setBookmark = useSetBookmark();

  const saved = state.data?.bookmarked ?? false;
  const label = saved ? 'Bỏ lưu' : 'Lưu';

  return (
    <button
      type="button"
      disabled={!isAuthenticated || !id || setBookmark.isPending}
      aria-pressed={saved}
      aria-label={label}
      // Explains the disabled state rather than leaving a dead control.
      title={isAuthenticated ? label : 'Đăng nhập để lưu lại'}
      onClick={() => {
        if (!id) return;
        void setBookmark.mutateAsync({ target, id, bookmarked: !saved });
      }}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1 text-sm disabled:opacity-50',
        saved
          ? 'text-[var(--color-primary)]'
          : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
        className,
      )}
    >
      <BookmarkIcon className={cn('h-4 w-4', saved && 'fill-current')} aria-hidden />
      {showLabel ? label : null}
    </button>
  );
}
