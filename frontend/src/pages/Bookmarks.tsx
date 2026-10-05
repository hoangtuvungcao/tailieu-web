import {
  Bookmark as BookmarkIcon,
  FileText,
  FolderInput,
  MessageSquare,
  Trash2,
  Folder,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { Button, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import {
  useBookmarkFolders,
  useBookmarks,
  useSetBookmark,
  type Bookmark,
  type TargetSummary,
} from '@/lib/social-hooks';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';

/**
 * Saved items.
 *
 * Every row here has already been checked against this reader on the server:
 * a bookmarked document whose owner has since made it private is not in the
 * response at all, and the folder counts beside the list are computed with the
 * same predicate — so a folder can never claim more items than opening it
 * shows.
 */

const TARGET_ROUTES: Record<TargetSummary['type'], string> = {
  document: '/documents',
  post: '/community',
  collection: '/collections',
};

const TARGET_ICONS = {
  document: FileText,
  post: MessageSquare,
  collection: Folder,
} as const;

export function BookmarksPage() {
  // `undefined` means every folder; the empty string is a real folder name that
  // would otherwise be indistinguishable from "no filter".
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(1);

  const query = useBookmarks({ folder, page });
  const folders = useBookmarkFolders();

  const bookmarks = query.data?.bookmarks ?? [];
  const meta = query.data?.meta;
  const folderList = folders.data ?? [];

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold tracking-tight">Đã lưu</h1>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Tài liệu, bài viết và bộ sưu tập bạn đã lưu. Chỉ mình bạn thấy danh sách này.
        </p>

        {/* The filter appears only once a folder exists. An empty chip row would
            be a control that cannot do anything. */}
        {folderList.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => {
                setFolder(undefined);
                setPage(1);
              }}
              aria-pressed={folder === undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium',
                folder === undefined
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                  : 'border-[var(--color-border)] text-[var(--color-muted-foreground)]',
              )}
            >
              Tất cả
            </button>
            {folderList.map((entry) => (
              <button
                key={entry.folder}
                type="button"
                onClick={() => {
                  setFolder(entry.folder);
                  setPage(1);
                }}
                aria-pressed={folder === entry.folder}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs font-medium',
                  folder === entry.folder
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                    : 'border-[var(--color-border)] text-[var(--color-muted-foreground)]',
                )}
              >
                {entry.folder} ({entry.total})
              </button>
            ))}
          </div>
        ) : null}

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
                  : 'Đã xảy ra lỗi khi tải danh sách đã lưu.'
              }
              onRetry={() => void query.refetch()}
            />
          ) : bookmarks.length === 0 ? (
            <EmptyState
              icon={<BookmarkIcon className="h-8 w-8" />}
              title={folder ? `Không có gì trong "${folder}"` : 'Bạn chưa lưu gì'}
              description={
                folder
                  ? 'Chọn "Tất cả" để xem mọi thứ bạn đã lưu.'
                  : 'Bấm nút Lưu trên một tài liệu hoặc bài viết để cất nó vào đây.'
              }
            />
          ) : (
            <ul className="space-y-3">
              {bookmarks.map((bookmark) => (
                <BookmarkRow key={bookmark.id} bookmark={bookmark} />
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

function BookmarkRow({ bookmark }: { bookmark: Bookmark }) {
  const setBookmark = useSetBookmark();
  const { target } = bookmark;
  const Icon = TARGET_ICONS[target.type] ?? FileText;

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-start gap-3 p-4">
        <span
          className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-muted)] text-[var(--color-muted-foreground)]"
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <Link
            to={`${TARGET_ROUTES[target.type]}/${target.id}`}
            className="font-medium hover:text-[var(--color-primary)]"
          >
            {target.title}
          </Link>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            {target.owner.displayName}
            {target.type === 'document' && target.sizeBytes
              ? ` · ${formatBytes(target.sizeBytes)}`
              : ''}
            {target.type === 'post'
              ? ` · ${target.stats.likes} thích · ${target.stats.comments} bình luận`
              : ''}
            {target.type === 'collection' ? ` · ${target.stats.items} mục` : ''}
            {' · đã lưu '}
            {formatRelativeTime(bookmark.savedAt)}
          </p>

          <FolderControl bookmark={bookmark} />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 text-[var(--color-destructive)] sm:h-8 sm:w-8"
          disabled={setBookmark.isPending}
          onClick={() =>
            setBookmark.mutate({
              target: target.type,
              id: target.id,
              bookmarked: false,
            })
          }
          aria-label="Bỏ lưu"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </li>
  );
}

/**
 * Move a saved item into a folder, or out of one.
 *
 * A text input with a datalist rather than a `<select>`: folders are created by
 * typing a name, so a closed list would make the first one impossible to create.
 * The datalist still offers the names already in use.
 *
 * Submitting an empty value sends an explicit `null`, which is the request that
 * means "take it out" — as opposed to leaving the field out, which the API reads
 * as "leave it where it is".
 */
function FolderControl({ bookmark }: { bookmark: Bookmark }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(bookmark.folder ?? '');
  const setBookmark = useSetBookmark();
  const folders = useBookmarkFolders();

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="mt-1.5 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]"
      >
        <FolderInput className="h-3.5 w-3.5" aria-hidden />
        {bookmark.folder ?? 'Thêm vào thư mục'}
      </button>
    );
  }

  function save() {
    const next = value.trim();
    setBookmark.mutate(
      {
        target: bookmark.target.type,
        id: bookmark.target.id,
        bookmarked: true,
        folder: next === '' ? null : next,
      },
      { onSuccess: () => setEditing(false) },
    );
  }

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        list="bookmark-folder-options"
        placeholder="Tên thư mục"
        aria-label="Tên thư mục"
        maxLength={60}
        className="h-7 w-44 text-xs"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          }
          if (event.key === 'Escape') setEditing(false);
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={save}
        disabled={setBookmark.isPending}
      >
        Lưu
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => setEditing(false)}
      >
        Huỷ
      </Button>
      {/* Suggested names, not a closed set. */}
      <datalist id="bookmark-folder-options">
        {(folders.data ?? []).map((entry) => (
          <option key={entry.folder} value={entry.folder} />
        ))}
      </datalist>
    </div>
  );
}
