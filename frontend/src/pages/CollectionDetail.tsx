import {
  ArrowDown,
  ArrowUp,
  FileText,
  Folder,
  Globe,
  Lock,
  MessageSquare,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Label,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  useAddCollectionItem,
  useCollection,
  useDeleteCollection,
  useRemoveCollectionItem,
  useReorderCollectionItems,
  useUpdateCollection,
  type CollectionItem,
} from '@/lib/social-hooks';
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils';

/**
 * One collection.
 *
 * Every item here has already passed the viewer's visibility check on the
 * server — the private document an owner parked in their public list is not in
 * this response at all, and the count above the list was computed from the same
 * filtered query, so the two cannot disagree.
 *
 * The controls are gated on `permissions`, which the server computes. That
 * gating is cosmetic: each mutation endpoint re-checks ownership, so a hidden
 * button that was un-hidden in devtools still gets a 404.
 */

const VISIBILITY_LABELS: Record<string, string> = {
  public: 'Công khai',
  internal: 'Nội bộ',
  private: 'Riêng tư',
};

const VISIBILITY_ICONS: Record<string, typeof Globe> = {
  public: Globe,
  internal: Users,
  private: Lock,
};

const TARGET_ROUTES: Record<CollectionItem['target']['type'], string> = {
  document: '/documents',
  post: '/community',
  collection: '/collections',
};

export function CollectionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAuthenticated } = useAuth();
  const [page, setPage] = useState(1);
  const query = useCollection(id, page);

  if (query.isLoading) {
    return (
      <div className="container-page py-8">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-4 h-4 w-96" />
        <div className="mt-8 space-y-3">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-20 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    const error = query.error;
    // A private collection answers 404 rather than 403, so "not found" is also
    // what a stranger sees for a collection that exists. The wording does not
    // pretend to know which it is.
    const notFound = error instanceof ApiError && error.status === 404;

    return (
      <div className="container-page py-8">
        <ErrorState
          message={
            notFound
              ? 'Không tìm thấy bộ sưu tập này, hoặc bạn không có quyền xem.'
              : error instanceof ApiError
                ? error.message
                : 'Đã xảy ra lỗi khi tải bộ sưu tập.'
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
        />
      </div>
    );
  }

  const { collection, meta } = query.data;
  const VisibilityIcon = VISIBILITY_ICONS[collection.visibility] ?? Lock;
  const items = collection.items ?? [];

  return (
    <div className="container-page py-8">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight">{collection.title}</h1>
              <Badge variant={collection.visibility === 'public' ? 'brand' : 'outline'}>
                <VisibilityIcon className="mr-1 h-3 w-3" aria-hidden />
                {VISIBILITY_LABELS[collection.visibility] ?? collection.visibility}
              </Badge>
            </div>
            <p className="mt-1.5 text-sm text-[var(--color-muted-foreground)]">
              {collection.owner.displayName} · {collection.itemCount} mục · cập nhật{' '}
              {formatRelativeTime(collection.updatedAt)}
            </p>
            {collection.description ? (
              <p className="mt-3 text-sm">{collection.description}</p>
            ) : null}
          </div>
          {collection.permissions.canEdit ? <OwnerActions collection={collection} /> : null}
        </div>

        {collection.permissions.canAddItem ? <AddItemForm collectionId={collection.id} /> : null}

        <div className="mt-6">
          {items.length === 0 ? (
            <EmptyState
              icon={<Folder className="h-8 w-8" />}
              title="Bộ sưu tập trống"
              description={
                collection.permissions.canAddItem
                  ? 'Thêm tài liệu hoặc bài viết vào bộ sưu tập này bằng ô phía trên.'
                  : 'Người tạo bộ sưu tập chưa thêm nội dung nào bạn có thể xem.'
              }
            />
          ) : (
            <ul className="space-y-3">
              {items.map((item, index) => (
                <CollectionItemRow
                  key={item.id}
                  item={item}
                  collectionId={collection.id}
                  canReorder={collection.permissions.canEdit}
                  isFirst={index === 0}
                  isLast={index === items.length - 1}
                  siblingIds={items.map((entry) => entry.id)}
                  canRemove={
                    collection.permissions.canEdit || collection.permissions.canDelete
                  }
                />
              ))}
            </ul>
          )}
        </div>

        {meta.totalPages > 1 ? (
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

        {!isAuthenticated ? (
          <p className="mt-8 text-center text-sm text-[var(--color-muted-foreground)]">
            <Link to="/login" className="text-[var(--color-primary)] hover:underline">
              Đăng nhập
            </Link>{' '}
            để tạo bộ sưu tập của riêng bạn.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function OwnerActions({
  collection,
}: {
  collection: { id: string; title: string; description: string | null; visibility: string };
}) {
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const update = useUpdateCollection();
  const remove = useDeleteCollection();

  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description ?? '');
  const [visibility, setVisibility] = useState(collection.visibility);

  if (confirmingDelete) {
    return (
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-3 p-4">
          <p className="text-sm">
            Xoá bộ sưu tập <strong>{collection.title}</strong>? Tài liệu bên trong
            không bị xoá — chỉ bộ sưu tập này.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
              Huỷ
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate(collection.id)}
            >
              {remove.isPending ? 'Đang xoá…' : 'Xoá'}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!editing) {
    return (
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Sửa
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-[var(--color-destructive)]"
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 className="h-4 w-4" />
          Xoá
        </Button>
      </div>
    );
  }

  return (
    <Card className="w-full max-w-lg">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Sửa bộ sưu tập</h2>
          <Button variant="ghost" size="icon" onClick={() => setEditing(false)} aria-label="Đóng">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(
              { collectionId: collection.id, title, description: description || null, visibility },
              { onSuccess: () => setEditing(false) },
            );
          }}
        >
          <Field label="Tên" htmlFor="edit-title">
            <Input
              id="edit-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
            />
          </Field>
          <Field label="Mô tả" htmlFor="edit-description">
            <Textarea
              id="edit-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={2000}
            />
          </Field>
          <div>
            <Label htmlFor="edit-visibility">Hiển thị</Label>
            <select
              id="edit-visibility"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value)}
              className="mt-1.5 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2 text-sm"
            >
              <option value="private">Riêng tư</option>
              <option value="internal">Nội bộ</option>
              <option value="public">Công khai</option>
            </select>
            {/* Said plainly, because making a collection public does not make
                its contents public — and a user who assumes it does would be
                surprised in the direction that matters. */}
            <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)]">
              Chuyển sang công khai không làm tài liệu riêng tư bên trong trở nên công
              khai. Người xem chỉ thấy những gì họ vốn được phép xem.
            </p>
          </div>

          {update.isError ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {update.error instanceof ApiError ? update.error.message : 'Không lưu được.'}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Huỷ
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Đang lưu…' : 'Lưu'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Add an item by pasting a link.
 *
 * The alternative — a picker that searches documents — needs a search UI that
 * does not exist yet, and a fake picker would be worse than none. A URL is the
 * one input that works today, because the ids are already in every link the
 * site renders.
 *
 * The server refuses anything the adder cannot see, so pasting a stranger's
 * private document link fails with a 404 rather than filing it away.
 */
function AddItemForm({ collectionId }: { collectionId: string }) {
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const add = useAddCollectionItem();

  const parsed = parseTargetUrl(url);
  const error =
    url.length > 0 && !parsed
      ? 'Dán liên kết tới một tài liệu, bài viết hoặc bộ sưu tập trên TAILIEU TTN.'
      : null;

  if (add.isSuccess && url.length === 0) {
    return null;
  }

  return (
    <Card className="mt-6">
      <CardContent className="p-4">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!parsed) return;
            add.mutate(
              {
                collectionId,
                targetType: parsed.type,
                targetId: parsed.id,
                note: note || null,
              },
              {
                onSuccess: () => {
                  setUrl('');
                  setNote('');
                },
              },
            );
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <Field
              label="Thêm bằng liên kết"
              htmlFor="item-url"
              hint="Ví dụ: /documents/… hoặc /community/…"
              error={error ?? undefined}
            >
              <Input
                id="item-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="Dán liên kết vào đây"
              />
            </Field>
            <Field label="Ghi chú" htmlFor="item-note">
              <Input
                id="item-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={500}
                placeholder="Không bắt buộc"
              />
            </Field>
          </div>

          {add.isError ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {add.error instanceof ApiError ? add.error.message : 'Không thêm được mục này.'}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!parsed || add.isPending}>
              {add.isPending ? 'Đang thêm…' : 'Thêm'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Pull the target out of a link the user pasted.
 *
 * Accepts a full URL or a path, because both are what the address bar and the
 * copy-link button produce. Returns `null` rather than guessing, so the form
 * refuses anything it cannot resolve instead of posting a made-up id.
 */
export function parseTargetUrl(
  input: string,
): { type: 'document' | 'post' | 'collection'; id: string } | null {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // Path prefixes, longest first so `/collections/` is not matched by a
  // looser rule before it is reached.
  const routes: [string, 'document' | 'post' | 'collection'][] = [
    ['/collections/', 'collection'],
    ['/documents/', 'document'],
    ['/community/', 'post'],
  ];

  let path = input.trim();
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }

  for (const [prefix, type] of routes) {
    const index = path.indexOf(prefix);
    if (index === -1) continue;
    const match = path.slice(index + prefix.length).match(UUID);
    if (match) return { type, id: match[0] };
  }

  return null;
}

function CollectionItemRow({
  item,
  collectionId,
  canReorder,
  canRemove,
  isFirst,
  isLast,
  siblingIds,
}: {
  item: CollectionItem;
  collectionId: string;
  canReorder: boolean;
  canRemove: boolean;
  isFirst: boolean;
  isLast: boolean;
  siblingIds: string[];
}) {
  const remove = useRemoveCollectionItem();
  const reorder = useReorderCollectionItems();

  const href = `${TARGET_ROUTES[item.target.type]}/${item.target.id}`;

  // The order sent is the whole visible list with this item moved, because the
  // server places the ids it is given first and leaves the rest in place. Sending
  // only a pair of positions would be ambiguous when two items share one.
  function move(direction: -1 | 1) {
    const index = siblingIds.indexOf(item.id);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= siblingIds.length) return;

    const next = [...siblingIds];
    [next[index], next[target]] = [next[target]!, next[index]!];
    reorder.mutate({ collectionId, itemIds: next });
  }

  const Icon =
    item.target.type === 'document' ? FileText : item.target.type === 'post' ? MessageSquare : Folder;

  return (
    <li className="rounded-lg border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-start gap-3 p-4">
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-muted)] text-[var(--color-muted-foreground)]"
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>

        <div className="min-w-0 flex-1">
          <Link to={href} className="font-medium hover:text-[var(--color-primary)]">
            {item.target.title}
          </Link>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            {item.target.owner.displayName}
            {item.target.type === 'document' && item.target.sizeBytes
              ? ` · ${formatBytes(item.target.sizeBytes)}`
              : ''}
            {item.target.type === 'post'
              ? ` · ${item.target.stats.likes} thích · ${item.target.stats.comments} bình luận`
              : ''}
            {item.target.type === 'collection' ? ` · ${item.target.stats.items} mục` : ''}
          </p>
          {item.note ? (
            <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">{item.note}</p>
          ) : null}
        </div>

        {/* 36px on touch rather than the 32px the mouse layout uses: these are
            small icon-only buttons that sit close together, which is the exact
            shape people mis-tap. The extra 4px costs the title ~12px of width
            on a 360px phone, which is the cheaper half of the trade. */}
        <div className="flex shrink-0 items-center gap-1">
          {canReorder ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 sm:h-8 sm:w-8"
                disabled={isFirst || reorder.isPending}
                onClick={() => move(-1)}
                aria-label="Chuyển lên"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 sm:h-8 sm:w-8"
                disabled={isLast || reorder.isPending}
                onClick={() => move(1)}
                aria-label="Chuyển xuống"
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          {canRemove ? (
            <Button
              variant="ghost"
              size="icon"
              className={cn('h-9 w-9 sm:h-8 sm:w-8', 'text-[var(--color-destructive)]')}
              disabled={remove.isPending}
              onClick={() => remove.mutate({ collectionId, itemId: item.id })}
              aria-label="Xoá khỏi bộ sưu tập"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
