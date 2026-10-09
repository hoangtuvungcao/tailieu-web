import {
  CheckCircle2,
  FileUp,
  RotateCcw,
  TriangleAlert,
  Upload as UploadIcon,
  X,
} from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Badge, Button, Card, CardContent, Field, Input, Textarea } from '@/components/ui';
import { api, ApiError, uploadChunk } from '@/lib/api-client';
import { useDocumentTypes, useFaculties, usePrograms } from '@/lib/hooks';
import { cn, formatBytes } from '@/lib/utils';

/**
 * Upload page.
 *
 * The chunked protocol is three steps and each is visible in the UI, because
 * a 300MB upload over a home connection WILL be interrupted and the user needs
 * to understand that resuming is possible rather than starting over:
 *
 *   1. POST /uploads           → chunk size, total chunks, which are already present
 *   2. PUT  /uploads/:id/chunks/:i   → one request per chunk, each under the
 *                                      Cloudflare 100MB proxy cap
 *   3. POST /uploads/:id/complete    → assemble, verify, deduplicate
 *
 * Chunks are sent sequentially rather than in parallel. Parallelism would be
 * faster on a fast connection, but on the laptop-behind-a-tunnel deployment
 * this targets, concurrent 8MB bodies compete for one upstream and mostly
 * produce timeouts that then need retrying. The same reasoning is why the
 * FILES are uploaded one after another rather than at once: ten concurrent
 * uploads would multiply that contention by ten.
 */

/**
 * The server's own ceiling. `documents.schema.ts` rejects more than ten
 * `uploadIds`, so accepting an eleventh here would only produce a document
 * that cannot be created. Enforced in the picker rather than at publish, so
 * the user is told while choosing files instead of after uploading them.
 */
const MAX_FILES = 10;

interface UploadState {
  fileName: string;
  sizeBytes: number;
  uploadId: string | null;
  totalChunks: number;
  completedChunks: number;
  status: 'idle' | 'uploading' | 'assembling' | 'done' | 'error';
  error: string | null;
  /** Set once the server confirms the assembled file. */
  completed: { contentHash: string; fileKind: string; sizeBytes: number } | null;
}

interface UploadItem {
  /**
   * A synthetic key, because nothing about a `File` is a stable React key:
   * two files may legitimately share a name and a size, and the same file can
   * be added twice under different names. Assigned once, never recomputed.
   */
  key: string;
  file: File;
  upload: UploadState;
}

const INITIAL: UploadState = {
  fileName: '',
  sizeBytes: 0,
  uploadId: null,
  totalChunks: 0,
  completedChunks: 0,
  status: 'idle',
  error: null,
  completed: null,
};

/** Two entries are the same file if all three of these match. */
function isSameFile(a: File, b: File) {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

export function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextKey = useRef(0);

  const [form, setForm] = useState({
    title: '',
    description: '',
    facultyId: '',
    programId: '',
    documentTypeId: '',
    visibility: 'internal' as 'public' | 'internal' | 'private',
    tags: '',
    confirmed: false,
  });

  const faculties = useFaculties();
  const programs = usePrograms(form.facultyId || undefined);
  const documentTypes = useDocumentTypes();

  /** Replace one item's upload state, leaving every other row untouched. */
  function patchItem(key: string, next: Partial<UploadState>) {
    setItems((current) =>
      current.map((row) =>
        row.key === key ? { ...row, upload: { ...row.upload, ...next } } : row,
      ),
    );
  }

  /**
   * Add files to the queue.
   *
   * Rejections are counted and reported rather than silently dropped: a user
   * who drags twelve files and sees ten rows has to be told why, or they will
   * assume the page lost two of them.
   */
  function addFiles(incoming: FileList | File[]) {
    const candidates = Array.from(incoming);
    const accepted: UploadItem[] = [];
    let duplicates = 0;
    let overflow = 0;

    for (const candidate of candidates) {
      if (items.length + accepted.length >= MAX_FILES) {
        overflow += 1;
        continue;
      }
      const alreadyQueued =
        items.some((row) => isSameFile(row.file, candidate)) ||
        accepted.some((row) => isSameFile(row.file, candidate));
      if (alreadyQueued) {
        duplicates += 1;
        continue;
      }
      nextKey.current += 1;
      accepted.push({
        key: `file-${nextKey.current}`,
        file: candidate,
        upload: { ...INITIAL, fileName: candidate.name, sizeBytes: candidate.size },
      });
    }

    if (accepted.length > 0) {
      setItems((current) => [...current, ...accepted]);
      // Pre-fill the title from the first file only. With several files there
      // is no single right answer, so the first one is a starting point the
      // user edits rather than a guess applied to all of them.
      setForm((current) => ({
        ...current,
        title: current.title || (items.length === 0 ? accepted[0].file.name.replace(/\.[^.]+$/, '') : ''),
      }));
    }

    const problems: string[] = [];
    if (duplicates > 0) problems.push(`${duplicates} tệp đã có trong danh sách`);
    if (overflow > 0) problems.push(`chỉ nhận tối đa ${MAX_FILES} tệp`);
    setNotice(problems.length > 0 ? `Đã bỏ qua: ${problems.join(', ')}.` : null);
  }

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
    },
    // `addFiles` reads `items`, so the handler has to be rebuilt when they
    // change; a stale closure would compare against a list that no longer
    // exists and let a duplicate through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  );

  /**
   * Send one file chunk by chunk.
   *
   * Resume is real: if a previous attempt for the same file exists, the server
   * reports which chunk indices it already holds and those are skipped. A
   * dropped connection costs one chunk, not the whole upload.
   *
   * Failures are caught here rather than propagated, so one bad file does not
   * abandon the rest of the queue.
   */
  async function runItem(item: UploadItem) {
    const { key, file } = item;
    patchItem(key, { status: 'uploading', error: null });

    try {
      // --- Step 1: intent -----------------------------------------------
      const intent = await api.post<{
        uploadId: string;
        chunkSize: number;
        totalChunks: number;
        receivedChunks: number[];
      }>('/uploads', {
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type || null,
      });

      const alreadyHave = new Set(intent.receivedChunks);
      let sent = alreadyHave.size;
      patchItem(key, {
        uploadId: intent.uploadId,
        totalChunks: intent.totalChunks,
        completedChunks: sent,
      });

      // --- Step 2: chunks -----------------------------------------------
      for (let index = 0; index < intent.totalChunks; index += 1) {
        if (alreadyHave.has(index)) continue;

        const start = index * intent.chunkSize;
        const blob = file.slice(start, Math.min(start + intent.chunkSize, file.size));

        await uploadChunk(intent.uploadId, index, blob, undefined, abortRef.current?.signal);

        sent += 1;
        patchItem(key, { completedChunks: sent });
      }

      // --- Step 3: assemble ---------------------------------------------
      patchItem(key, { status: 'assembling' });

      const completed = await api.post<{
        contentHash: string;
        fileKind: string;
        sizeBytes: number;
        deduplicated: boolean;
      }>(`/uploads/${intent.uploadId}/complete`);

      patchItem(key, {
        status: 'done',
        completed: {
          contentHash: completed.contentHash,
          fileKind: completed.fileKind,
          sizeBytes: completed.sizeBytes,
        },
      });
    } catch (error) {
      patchItem(key, {
        status: 'error',
        error:
          error instanceof ApiError
            ? error.message
            : 'Tải lên thất bại. Vui lòng kiểm tra kết nối và thử lại.',
      });
    }
  }

  /** Upload everything still outstanding, one file at a time. */
  async function startUploads() {
    // Re-read the queue rather than trusting a captured copy: a retry may have
    // replaced an item since the render that produced this handler.
    const queue = items.filter((item) => item.upload.status !== 'done');
    if (queue.length === 0) return;

    abortRef.current = new AbortController();
    setRunning(true);
    setNotice(null);
    try {
      for (const item of queue) {
        await runItem(item);
      }
    } finally {
      setRunning(false);
    }
  }

  /** Retry a single failed file without touching the ones that succeeded. */
  async function retryItem(item: UploadItem) {
    abortRef.current = new AbortController();
    setRunning(true);
    setNotice(null);
    try {
      await runItem(item);
    } finally {
      setRunning(false);
    }
  }

  async function cancelAll() {
    abortRef.current?.abort();
    // Best-effort: telling the server releases the multipart upload and its
    // parts. If this fails the nightly reaper still cleans it up.
    await Promise.all(
      items
        .filter((item) => item.upload.uploadId && item.upload.status !== 'done')
        .map((item) => api.delete(`/uploads/${item.upload.uploadId}`).catch(() => undefined)),
    );
    setItems([]);
    setNotice(null);
  }

  async function removeItem(item: UploadItem) {
    if (item.upload.uploadId && item.upload.status !== 'done') {
      // Abandoning a session the server still holds parts for.
      await api.delete(`/uploads/${item.upload.uploadId}`).catch(() => undefined);
    }
    setItems((current) => current.filter((row) => row.key !== item.key));
  }

  /** Create the document from every finished upload. */
  async function publish() {
    const uploadIds = items
      .map((item) => item.upload.uploadId)
      .filter((id): id is string => Boolean(id));
    if (uploadIds.length === 0) return;

    setPublishing(true);
    setNotice(null);

    try {
      const document = await api.post<{ id: string }>('/documents', {
        title: form.title.trim(),
        description: form.description.trim() || null,
        documentTypeId: form.documentTypeId,
        facultyId: form.facultyId,
        programId: form.programId || null,
        visibility: form.visibility,
        // Order is meaningful: the server marks `index === 0` as the primary
        // file, and that is the one the detail page previews by default. The
        // array is in queue order, so the first row the user added is primary.
        uploadIds,
        tags: form.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        uploaderConfirmed: form.confirmed,
      });

      navigate(`/documents/${document.id}`);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : 'Không tạo được tài liệu.');
      setPublishing(false);
    }
  }

  const allDone = items.length > 0 && items.every((item) => item.upload.status === 'done');
  const doneCount = items.filter((item) => item.upload.status === 'done').length;
  const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);
  const hasUnfinished = items.some(
    (item) => item.upload.status === 'idle' || item.upload.status === 'error',
  );
  const atCapacity = items.length >= MAX_FILES;

  const canPublish =
    allDone && form.title.trim().length >= 3 && form.facultyId && form.documentTypeId && form.confirmed;

  return (
    <div className="container-page max-w-3xl py-8">
      <h1 className="text-2xl font-bold tracking-tight">Tải lên tài liệu</h1>
      <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
        Chia sẻ ghi chép bài học, đề cương tóm tắt, sơ đồ tư duy hoặc bài tập tự luyện của bạn.
      </p>

      {/* --- Copyright & Academic Guidelines Banner --- */}
      <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
        <p className="font-semibold text-amber-600 dark:text-amber-400">
          ⚠️ Quy định về bản quyền &amp; nội dung học tập:
        </p>
        <ul className="mt-1.5 list-disc space-y-1 pl-4">
          <li>
            <strong>KHÔNG tải lên:</strong> Bản scan giáo trình xuất bản thương mại, Slide bài giảng nguyên gốc của giảng viên khi chưa có sự đồng ý, hoặc Đề thi nội bộ thuộc diện bảo mật.
          </li>
          <li>
            <strong>KHUYẾN KHÍCH:</strong> Ghi chép tự soạn (Student notes), Đề cương tóm tắt kiến thức, Sơ đồ tư duy (Mindmap), Bài tập tự luyện và Lời giải tham khảo.
          </li>
        </ul>
      </div>

      {/* --- Drop zone ---------------------------------------------------- */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!atCapacity) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'rounded-lg border-2 border-dashed text-center transition-colors',
          items.length === 0 ? 'mt-6 p-12' : 'mt-6 p-5',
          atCapacity
            ? 'border-[var(--color-border)] opacity-60'
            : dragging
              ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
              : 'border-[var(--color-border)]',
        )}
      >
        <FileUp
          className={cn(
            'mx-auto text-[var(--color-muted-foreground)]',
            items.length === 0 ? 'h-10 w-10' : 'h-6 w-6',
          )}
          aria-hidden
        />
        <p className={cn('font-medium', items.length === 0 ? 'mt-3 text-sm' : 'mt-2 text-sm')}>
          {atCapacity
            ? `Đã đạt giới hạn ${MAX_FILES} tệp`
            : items.length === 0
              ? 'Kéo thả tệp vào đây'
              : 'Thêm tệp khác'}
        </p>
        {!atCapacity ? (
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            {items.length === 0
              ? 'hoặc chọn tệp từ máy của bạn — có thể chọn nhiều tệp cùng lúc'
              : `Còn nhận được ${MAX_FILES - items.length} tệp`}
          </p>
        ) : null}
        <Button
          className="mt-4"
          variant={items.length === 0 ? 'default' : 'outline'}
          size={items.length === 0 ? 'default' : 'sm'}
          disabled={atCapacity}
          onClick={() => fileInputRef.current?.click()}
        >
          {items.length === 0 ? 'Chọn tệp' : 'Thêm tệp'}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            // Cleared so that picking the same file again still fires a change
            // event — otherwise the second attempt does nothing at all.
            event.target.value = '';
          }}
        />
        {items.length === 0 ? (
          <p className="mt-4 text-xs text-[var(--color-muted-foreground)]">
            Hỗ trợ PDF, Word, Excel, PowerPoint, ảnh, nén, văn bản và mã nguồn. Tối đa {MAX_FILES} tệp
            mỗi tài liệu.
          </p>
        ) : null}
      </div>

      {/* --- Queue -------------------------------------------------------- */}

      {notice ? (
        <p
          role="status"
          className="mt-3 flex items-start gap-2 text-sm text-[var(--color-muted-foreground)]"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="break-words">{notice}</span>
        </p>
      ) : null}

      {items.length > 0 ? (
        <Card className="mt-4">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">
                Tệp đã chọn
                <span className="ml-2 text-sm font-normal text-[var(--color-muted-foreground)]">
                  {doneCount}/{items.length} · {formatBytes(totalBytes)}
                </span>
              </h2>
              <div className="flex items-center gap-2">
                {hasUnfinished && !running ? (
                  <Button size="sm" className="gap-2" onClick={() => void startUploads()}>
                    <UploadIcon className="h-4 w-4" />
                    {doneCount > 0 ? 'Tải tiếp' : 'Bắt đầu tải lên'}
                  </Button>
                ) : null}
                {running ? (
                  <Button variant="outline" size="sm" onClick={() => void cancelAll()}>
                    Huỷ
                  </Button>
                ) : null}
              </div>
            </div>

            <ul className="mt-4 divide-y divide-[var(--color-border)]">
              {items.map((item, index) => {
                const { upload } = item;
                const progress =
                  upload.totalChunks > 0
                    ? Math.round((upload.completedChunks / upload.totalChunks) * 100)
                    : 0;
                const busy = upload.status === 'uploading' || upload.status === 'assembling';

                return (
                  <li key={item.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium">{item.file.name}</p>
                        {index === 0 ? (
                          <Badge variant="outline" className="shrink-0">
                            Tệp chính
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                        {formatBytes(item.file.size)}
                        {upload.totalChunks > 0 ? ` · ${upload.totalChunks} phần` : ''}
                      </p>

                      {busy ? (
                        <div className="mt-2">
                          <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-muted)]">
                            <div
                              className="h-full bg-[var(--color-primary)] transition-all"
                              style={{
                                width: `${upload.status === 'assembling' ? 100 : progress}%`,
                              }}
                              role="progressbar"
                              aria-valuenow={progress}
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-label={`Tiến độ tải lên ${item.file.name}`}
                            />
                          </div>
                          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                            {upload.status === 'assembling'
                              ? 'Đang ghép và kiểm tra tệp…'
                              : `Đã gửi ${upload.completedChunks}/${upload.totalChunks} phần (${progress}%)`}
                          </p>
                        </div>
                      ) : upload.status === 'done' ? (
                        <p className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--color-success)]">
                          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
                          <span>
                            Tải lên hoàn tất ({formatBytes(upload.completed?.sizeBytes ?? item.file.size)})
                          </span>
                          {upload.completed ? (
                            <Badge variant="outline" className="font-normal">
                              {upload.completed.fileKind}
                            </Badge>
                          ) : null}
                        </p>
                      ) : upload.status === 'error' ? (
                        <div className="mt-1.5 space-y-2">
                          <p
                            role="alert"
                            className="flex items-start gap-2 text-xs text-[var(--color-destructive)]"
                          >
                            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span className="break-words">{upload.error}</span>
                          </p>
                          {/* Retrying reuses the existing session, so chunks
                              already accepted are not re-sent. */}
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            disabled={running}
                            onClick={() => void retryItem(item)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            Thử lại
                          </Button>
                        </div>
                      ) : (
                        <p className="mt-1.5 text-xs text-[var(--color-muted-foreground)]">
                          Chờ tải lên
                        </p>
                      )}
                    </div>

                    {!busy ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={publishing}
                        onClick={() => void removeItem(item)}
                        aria-label={`Bỏ tệp ${item.file.name}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>

            {items.length > 1 ? (
              <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
                Tệp đầu tiên là tệp chính — tệp này được xem trước và tải xuống mặc định.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* --- Metadata ----------------------------------------------------- */}
      <Card className="mt-6">
        <CardContent className="space-y-4 p-5">
          <h2 className="font-semibold">Thông tin tài liệu</h2>

          <Field label="Tiêu đề" htmlFor="title" required>
            <Input
              id="title"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Ví dụ: Bài giảng Lập trình C++ — Chương 1"
            />
          </Field>

          <Field label="Mô tả" htmlFor="description">
            <Textarea
              id="description"
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Tóm tắt nội dung, phạm vi kiến thức, hoặc ghi chú cho người đọc."
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Khoa" htmlFor="facultyId" required>
              <select
                id="facultyId"
                value={form.facultyId}
                onChange={(event) =>
                  // Clearing the program when the faculty changes: a program
                  // from the previous faculty would be an invalid pairing.
                  setForm({ ...form, facultyId: event.target.value, programId: '' })
                }
                className="h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
              >
                <option value="">Chọn khoa…</option>
                {(faculties.data ?? []).map((faculty) => (
                  <option key={faculty.id} value={faculty.id}>
                    {faculty.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Ngành" htmlFor="programId">
              <select
                id="programId"
                value={form.programId}
                onChange={(event) => setForm({ ...form, programId: event.target.value })}
                disabled={!form.facultyId}
                className="h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm disabled:opacity-50"
              >
                <option value="">Không chọn</option>
                {(programs.data ?? []).map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Loại tài liệu" htmlFor="documentTypeId" required>
              <select
                id="documentTypeId"
                value={form.documentTypeId}
                onChange={(event) => setForm({ ...form, documentTypeId: event.target.value })}
                className="h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
              >
                <option value="">Chọn loại…</option>
                {(documentTypes.data ?? []).map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Chế độ hiển thị"
              htmlFor="visibility"
              hint="Nội bộ: chỉ người đã đăng nhập. Công khai: ai cũng xem được."
            >
              <select
                id="visibility"
                value={form.visibility}
                onChange={(event) =>
                  setForm({ ...form, visibility: event.target.value as typeof form.visibility })
                }
                className="h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
              >
                <option value="internal">Nội bộ</option>
                <option value="public">Công khai</option>
                <option value="private">Riêng tư</option>
              </select>
            </Field>
          </div>

          <Field label="Thẻ" htmlFor="tags" hint="Phân cách bằng dấu phẩy. Ví dụ: C++, Giải thuật, Ôn thi">
            <Input
              id="tags"
              value={form.tags}
              onChange={(event) => setForm({ ...form, tags: event.target.value })}
              placeholder="C++, Cấu trúc dữ liệu, Ôn thi cuối kỳ"
            />
          </Field>

          <label className="flex items-start gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/20 p-3.5 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={form.confirmed}
              onChange={(event) => setForm({ ...form, confirmed: event.target.checked })}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              <strong className="text-[var(--color-foreground)]">Cam kết về bản quyền &amp; học liệu mở:</strong> Tôi cam đoan tài liệu này do chính tôi ghi chép/tổng hợp hoặc là tài liệu học tập mở được phép chia sẻ, không xâm phạm quyền tác giả hay quy chế bảo mật thi cử.
              <span className="mt-1 block text-xs text-[var(--color-muted-foreground)]">
                Tài liệu bị khiếu nại bản quyền sẽ bị gỡ bỏ ngay lập tức và tài khoản vi phạm có thể bị đình chỉ.
              </span>
            </span>
          </label>

          {notice && !running ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {notice}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!canPublish || publishing} onClick={() => void publish()}>
              {publishing ? 'Đang đăng…' : 'Đăng tài liệu'}
            </Button>
            {!canPublish ? (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {items.length === 0
                  ? 'Chọn ít nhất một tệp.'
                  : !allDone
                    ? 'Hoàn tất tải tất cả các tệp trước.'
                    : 'Điền tiêu đề, khoa, loại tài liệu và xác nhận bản quyền.'}
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
