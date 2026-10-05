import { FolderPlus, Globe, Lock, Users, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import {
  useCollections,
  useCreateCollection,
  useMyCollections,
  type Collection,
} from '@/lib/social-hooks';
import { cn, formatRelativeTime } from '@/lib/utils';

/**
 * Collections.
 *
 * Two tabs over the same shape, because they are the same list under different
 * predicates and the difference is the whole point: "Khám phá" is what the
 * viewer is allowed to see, "Của tôi" is everything they own including the
 * drafts. A single list that silently included private items would be a
 * nonsense read for a stranger; two separate endpoints make the distinction
 * explicit rather than something the client has to remember.
 *
 * The item count shown here is the viewer-visible one, computed server-side.
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

export function CollectionsPage() {
  const { isAuthenticated } = useAuth();
  const [tab, setTab] = useState<'discover' | 'mine'>('discover');
  // A signed-out visitor has no "mine" to switch to, so the tab is not offered
  // rather than shown and then emptied.
  const activeTab = isAuthenticated ? tab : 'discover';

  const discover = useCollections({ limit: 24 });
  const mine = useMyCollections({ limit: 24 });

  const query = activeTab === 'mine' ? mine : discover;
  const collections = query.data?.collections ?? [];

  return (
    <div className="container-page py-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Bộ sưu tập</h1>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            Tập hợp tài liệu và bài viết theo chủ đề, do cộng đồng biên soạn.
          </p>
        </div>
        {isAuthenticated ? <CreateCollectionButton /> : null}
      </div>

      {isAuthenticated ? (
        <div className="mt-6 flex rounded-md border border-[var(--color-border)] p-0.5 w-fit">
          {([
            { key: 'discover', label: 'Khám phá' },
            { key: 'mine', label: 'Của tôi' },
          ] as const).map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={activeTab === option.key}
              onClick={() => setTab(option.key)}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium',
                activeTab === option.key
                  ? 'bg-[var(--color-secondary)]'
                  : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mt-6">
        {query.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-36 rounded-lg" />
            ))}
          </div>
        ) : query.isError ? (
          <ErrorState
            message={
              query.error instanceof ApiError
                ? query.error.message
                : 'Đã xảy ra lỗi khi tải danh sách.'
            }
            onRetry={() => void query.refetch()}
          />
        ) : collections.length === 0 ? (
          <EmptyState
            icon={<FolderPlus className="h-8 w-8" />}
            title={activeTab === 'mine' ? 'Bạn chưa có bộ sưu tập nào' : 'Chưa có bộ sưu tập công khai'}
            description={
              activeTab === 'mine'
                ? 'Tạo một bộ sưu tập để gom tài liệu theo môn học hoặc chủ đề bạn quan tâm.'
                : 'Khi có người tạo bộ sưu tập công khai, chúng sẽ xuất hiện ở đây.'
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {collections.map((collection) => (
              <CollectionCard key={collection.id} collection={collection} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CollectionCard({ collection }: { collection: Collection }) {
  const VisibilityIcon = VISIBILITY_ICONS[collection.visibility] ?? Lock;

  return (
    <Link
      to={`/collections/${collection.id}`}
      className="group rounded-lg border border-[var(--color-border)] transition-colors hover:border-[var(--color-primary)]"
    >
      <Card className="h-full border-0 shadow-none">
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-semibold leading-snug group-hover:text-[var(--color-primary)]">
              {collection.title}
            </h2>
            <Badge variant={collection.visibility === 'public' ? 'brand' : 'outline'}>
              <VisibilityIcon className="mr-1 h-3 w-3" aria-hidden />
              {VISIBILITY_LABELS[collection.visibility] ?? collection.visibility}
            </Badge>
          </div>

          {collection.description ? (
            <p className="line-clamp-2 text-sm text-[var(--color-muted-foreground)]">
              {collection.description}
            </p>
          ) : null}

          <div className="mt-auto flex items-center justify-between text-xs text-[var(--color-muted-foreground)]">
            <span className="truncate">{collection.owner.displayName}</span>
            {/* The count the API computed for this viewer, not the stored one.
                A header that disagreed with the list inside would be the same
                defect as a comment count that disagreed with its thread. */}
            <span>
              {collection.itemCount} mục · {formatRelativeTime(collection.updatedAt)}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function CreateCollectionButton() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button className="gap-2" onClick={() => setOpen(true)}>
        <FolderPlus className="h-4 w-4" />
        Tạo bộ sưu tập
      </Button>
    );
  }

  return <CreateCollectionForm onClose={() => setOpen(false)} />;
}

function CreateCollectionForm({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState('private');
  const create = useCreateCollection();

  const fieldErrors = create.error instanceof ApiError ? create.error.fieldErrors : {};

  return (
    <Card className="w-full max-w-lg">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Bộ sưu tập mới</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Đóng">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate(
              { title, description: description || null, visibility },
              { onSuccess: onClose },
            );
          }}
        >
          <Field label="Tên bộ sưu tập" htmlFor="collection-title" required error={fieldErrors.title?.[0]}>
            <Input
              id="collection-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
              autoFocus
            />
          </Field>

          <Field label="Mô tả" htmlFor="collection-description" error={fieldErrors.description?.[0]}>
            <Textarea
              id="collection-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={2000}
            />
          </Field>

          <fieldset>
            <legend className="text-sm font-medium leading-none">Hiển thị</legend>
            <div className="mt-1.5 space-y-2">
              {([
                { value: 'private', label: 'Riêng tư', hint: 'Chỉ mình bạn thấy.' },
                { value: 'internal', label: 'Nội bộ', hint: 'Người đã đăng nhập thấy.' },
                { value: 'public', label: 'Công khai', hint: 'Ai cũng thấy.' },
              ] as const).map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border border-[var(--color-border)] p-2.5"
                >
                  <input
                    type="radio"
                    name="visibility"
                    value={option.value}
                    checked={visibility === option.value}
                    onChange={() => setVisibility(option.value)}
                    className="mt-1"
                  />
                  <span className="text-sm">
                    <span className="font-medium">{option.label}</span>
                    <span className="block text-xs text-[var(--color-muted-foreground)]">
                      {option.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {create.isError ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {create.error instanceof ApiError ? create.error.message : 'Không tạo được bộ sưu tập.'}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={create.isPending || title.trim().length === 0}>
              {create.isPending ? 'Đang tạo…' : 'Tạo'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
