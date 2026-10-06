import { Check, FileText, RotateCcw, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
} from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import { useAdminDocuments, useModerateDocument } from '@/lib/admin-hooks';
import { useDeleteDocument } from '@/lib/hooks';
import { formatBytes, formatRelativeTime } from '@/lib/utils';
import { AdminPageHeader } from './AdminLayout';

/**
 * The moderation queue.
 *
 * Every document whose type requires approval lands in `pending_review`, and
 * until this screen existed nothing could move it out: the queue endpoint, the
 * `documents.moderate` permission, the status machine and the audit entry were
 * all built, and the only way to publish a document was to edit its row in
 * PostgreSQL. The dashboard meanwhile reported the backlog, so an operator
 * could watch the number grow and do nothing about it.
 *
 * Faculty scope is enforced by the server, not here — `moderateDocument`
 * re-checks that the moderator's faculty covers the document's, so a faculty
 * moderator who reaches this page still sees only what they may act on. The
 * filter below narrows; it does not authorise.
 */

const STATUS_FILTERS = [
  {
    key: 'pending_review',
    label: 'Chờ duyệt',
    empty: 'Không có tài liệu nào chờ duyệt.',
    hint: 'Tài liệu đã tải lên và đang chờ quyết định.',
  },
  {
    key: 'published',
    label: 'Đã đăng',
    empty: 'Chưa có tài liệu nào được đăng.',
    hint: 'Đang hiển thị với người đọc theo mức hiển thị của từng tài liệu.',
  },
  {
    key: 'rejected',
    label: 'Bị từ chối',
    empty: 'Chưa từ chối tài liệu nào.',
    hint: 'Không hiển thị. Người tải lên thấy lý do trong nhật ký kiểm duyệt.',
  },
  {
    key: 'archived',
    label: 'Đã lưu trữ',
    empty: 'Chưa lưu trữ tài liệu nào.',
    hint: 'Ẩn khỏi danh sách nhưng vẫn giữ nguyên dữ liệu.',
  },
] as const;

export function AdminDocumentsPage() {
  const [status, setStatus] = useState<string>('pending_review');
  const [page, setPage] = useState(1);
  const [reason, setReason] = useState<Record<string, string>>({});
  /** Which card is mid-action, so only its own buttons show a spinner. */
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const query = useAdminDocuments({ status, page, limit: 20 });
  const moderate = useModerateDocument();
  const deleteDoc = useDeleteDocument();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const meta = query.data?.meta;
  const active = STATUS_FILTERS.find((option) => option.key === status);

  async function act(
    id: string,
    action: 'publish' | 'reject' | 'archive' | 'restore',
  ): Promise<void> {
    setError(null);
    setActingId(id);
    try {
      await moderate.mutateAsync({ id, action, reason: reason[id] });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Không cập nhật được tài liệu.');
    } finally {
      setActingId(null);
    }
  }

  return (
    <>
      <AdminPageHeader
        title="Kiểm duyệt tài liệu"
        description="Duyệt, từ chối hoặc lưu trữ tài liệu. Mới nhất trước."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-md border border-[var(--color-destructive)]/30 px-3 py-2 text-sm text-[var(--color-destructive)]">
          {error}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-1 rounded-md border border-[var(--color-border)] p-0.5">
        {STATUS_FILTERS.map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => {
              setStatus(option.key);
              setPage(1);
            }}
            aria-pressed={status === option.key}
            className={
              status === option.key
                ? 'rounded bg-[var(--color-secondary)] px-3 py-1 text-xs font-medium'
                : 'rounded px-3 py-1 text-xs text-[var(--color-muted-foreground)] hover:bg-[var(--color-muted)]'
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      {active ? (
        <p className="mb-4 text-xs text-[var(--color-muted-foreground)]">{active.hint}</p>
      ) : null}

      {query.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-32" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          message="Không tải được hàng đợi kiểm duyệt."
          onRetry={() => void query.refetch()}
        />
      ) : (query.data?.documents.length ?? 0) === 0 ? (
        <EmptyState
          icon={<FileText className="h-8 w-8" />}
          title="Không có tài liệu nào"
          description={active?.empty ?? 'Không có gì cần xử lý.'}
        />
      ) : (
        <div className="space-y-3">
          {query.data?.documents.map((document) => (
            <Card key={document.id}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      to={`/documents/${document.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {document.title}
                    </Link>
                    <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                      {document.owner?.displayName ?? 'Không rõ người tải lên'}
                      {document.taxonomy.faculty ? ` · ${document.taxonomy.faculty.name}` : ''}
                      {document.taxonomy.documentType
                        ? ` · ${document.taxonomy.documentType.name}`
                        : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Badge variant="outline">{document.visibility}</Badge>
                    {document.sizeBytes ? (
                      <span className="text-xs text-[var(--color-muted-foreground)]">
                        {formatBytes(document.sizeBytes)}
                      </span>
                    ) : null}
                    <span className="text-xs text-[var(--color-muted-foreground)]">
                      {formatRelativeTime(document.createdAt)}
                    </span>
                  </div>
                </div>

                {document.description ? (
                  <p className="line-clamp-2 text-sm text-[var(--color-muted-foreground)]">
                    {document.description}
                  </p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Input
                    value={reason[document.id] ?? ''}
                    onChange={(event) =>
                      setReason((current) => ({ ...current, [document.id]: event.target.value }))
                    }
                    placeholder="Lý do (nên ghi khi từ chối)…"
                    aria-label="Lý do kiểm duyệt"
                    className="min-w-48 flex-1"
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  {document.status === 'pending_review' ? (
                    <>
                      <Button
                        size="sm"
                        className="gap-1.5"
                        isLoading={actingId === document.id}
                        onClick={() => void act(document.id, 'publish')}
                      >
                        <Check className="h-4 w-4" aria-hidden />
                        Duyệt đăng
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-[var(--color-destructive)]"
                        isLoading={actingId === document.id}
                        onClick={() => void act(document.id, 'reject')}
                      >
                        <X className="h-4 w-4" aria-hidden />
                        Từ chối
                      </Button>
                    </>
                  ) : null}

                  {document.status === 'published' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      isLoading={actingId === document.id}
                      onClick={() => void act(document.id, 'archive')}
                    >
                      Lưu trữ
                    </Button>
                  ) : null}

                  {document.status === 'rejected' || document.status === 'archived' ? (
                    // One button, two labels, because "restore" publishes in
                    // both cases and calling it differently by source status
                    // would imply a difference the API does not have.
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      isLoading={actingId === document.id}
                      onClick={() => void act(document.id, 'restore')}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      Đăng lại
                    </Button>
                  ) : null}

                  {confirmDeleteId === document.id ? (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="destructive"
                        isLoading={deleteDoc.isPending}
                        onClick={async () => {
                          setError(null);
                          try {
                            await deleteDoc.mutateAsync(document.id);
                            setConfirmDeleteId(null);
                            void query.refetch();
                          } catch (caught) {
                            setError(
                              caught instanceof ApiError
                                ? caught.message
                                : 'Không xoá được tài liệu.',
                            );
                          }
                        }}
                      >
                        Xác nhận xoá
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDeleteId(null)}
                      >
                        Huỷ
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
                      onClick={() => setConfirmDeleteId(document.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Xoá
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}

          {meta && meta.totalPages > 1 ? (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-[var(--color-muted-foreground)]">
                Trang {meta.page}/{meta.totalPages} · {meta.total} tài liệu
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Trước
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= meta.totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Sau
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
