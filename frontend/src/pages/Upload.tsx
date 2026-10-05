import { CheckCircle2, FileUp, Upload as UploadIcon, X } from 'lucide-react';
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
 * produce timeouts that then need retrying.
 */

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

export function UploadPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [upload, setUpload] = useState<UploadState>(INITIAL);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files[0];
    if (dropped) selectFile(dropped);
  }, []);

  function selectFile(selected: File) {
    setFile(selected);
    setUpload({ ...INITIAL, fileName: selected.name, sizeBytes: selected.size });
    // Pre-fill the title from the filename minus its extension, which is
    // usually most of what the user would type anyway.
    setForm((current) => ({
      ...current,
      title: current.title || selected.name.replace(/\.[^.]+$/, ''),
    }));
  }

  /**
   * Send the file chunk by chunk.
   *
   * Resume is real: if a previous attempt for the same file exists, the server
   * reports which chunk indices it already holds and those are skipped. A
   * dropped connection costs one chunk, not the whole upload.
   */
  async function startUpload() {
    if (!file) return;

    abortRef.current = new AbortController();
    setUpload((state) => ({ ...state, status: 'uploading', error: null }));

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
      setUpload((state) => ({
        ...state,
        uploadId: intent.uploadId,
        totalChunks: intent.totalChunks,
        completedChunks: alreadyHave.size,
      }));

      // --- Step 2: chunks -----------------------------------------------
      for (let index = 0; index < intent.totalChunks; index += 1) {
        if (alreadyHave.has(index)) continue;

        const start = index * intent.chunkSize;
        const blob = file.slice(start, Math.min(start + intent.chunkSize, file.size));

        await uploadChunk(intent.uploadId, index, blob, undefined, abortRef.current.signal);

        setUpload((state) => ({ ...state, completedChunks: state.completedChunks + 1 }));
      }

      // --- Step 3: assemble ---------------------------------------------
      setUpload((state) => ({ ...state, status: 'assembling' }));

      const completed = await api.post<{
        contentHash: string;
        fileKind: string;
        sizeBytes: number;
        deduplicated: boolean;
      }>(`/uploads/${intent.uploadId}/complete`);

      setUpload((state) => ({
        ...state,
        status: 'done',
        completed: {
          contentHash: completed.contentHash,
          fileKind: completed.fileKind,
          sizeBytes: completed.sizeBytes,
        },
      }));
    } catch (error) {
      setUpload((state) => ({
        ...state,
        status: 'error',
        error:
          error instanceof ApiError
            ? error.message
            : 'Tải lên thất bại. Vui lòng kiểm tra kết nối và thử lại.',
      }));
    }
  }

  async function cancelUpload() {
    abortRef.current?.abort();
    if (upload.uploadId) {
      // Best-effort: telling the server releases the multipart upload and its
      // parts. If this fails the nightly reaper still cleans it up.
      await api.delete(`/uploads/${upload.uploadId}`).catch(() => undefined);
    }
    setUpload(INITIAL);
    setFile(null);
  }

  /** Create the document from the finished upload. */
  async function publish() {
    if (!upload.uploadId) return;

    setUpload((state) => ({ ...state, status: 'assembling', error: null }));

    try {
      const document = await api.post<{ id: string }>('/documents', {
        title: form.title.trim(),
        description: form.description.trim() || null,
        documentTypeId: form.documentTypeId,
        facultyId: form.facultyId,
        programId: form.programId || null,
        visibility: form.visibility,
        uploadIds: [upload.uploadId],
        tags: form.tags
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
        uploaderConfirmed: form.confirmed,
      });

      navigate(`/documents/${document.id}`);
    } catch (error) {
      setUpload((state) => ({
        ...state,
        status: 'error',
        error: error instanceof ApiError ? error.message : 'Không tạo được tài liệu.',
      }));
    }
  }

  const progress =
    upload.totalChunks > 0 ? Math.round((upload.completedChunks / upload.totalChunks) * 100) : 0;

  const canPublish =
    upload.status === 'done' &&
    form.title.trim().length >= 3 &&
    form.facultyId &&
    form.documentTypeId &&
    form.confirmed;

  return (
    <div className="container-page max-w-3xl py-8">
      <h1 className="text-2xl font-bold tracking-tight">Tải lên tài liệu</h1>
      <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
        Chia sẻ bài giảng, đề thi, giáo trình hoặc tài liệu học tập của bạn.
      </p>

      {/* --- Drop zone ---------------------------------------------------- */}
      {!file ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'mt-6 rounded-lg border-2 border-dashed p-12 text-center transition-colors',
            dragging
              ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)]'
              : 'border-[var(--color-border)]',
          )}
        >
          <FileUp className="mx-auto h-10 w-10 text-[var(--color-muted-foreground)]" aria-hidden />
          <p className="mt-3 text-sm font-medium">Kéo thả tệp vào đây</p>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            hoặc chọn tệp từ máy của bạn
          </p>
          <Button className="mt-4" onClick={() => fileInputRef.current?.click()}>
            Chọn tệp
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) selectFile(selected);
            }}
          />
          <p className="mt-4 text-xs text-[var(--color-muted-foreground)]">
            Hỗ trợ PDF, Word, Excel, PowerPoint, ảnh, nén, văn bản và mã nguồn.
          </p>
        </div>
      ) : (
        <Card className="mt-6">
          <CardContent className="space-y-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">{file.name}</p>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  {formatBytes(file.size)}
                  {upload.totalChunks > 0 ? ` · ${upload.totalChunks} phần` : ''}
                </p>
              </div>
              {upload.status === 'idle' || upload.status === 'error' ? (
                <Button variant="ghost" size="icon" onClick={() => void cancelUpload()} aria-label="Bỏ tệp">
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>

            {upload.status === 'uploading' || upload.status === 'assembling' ? (
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--color-muted)]">
                  <div
                    className="h-full bg-[var(--color-primary)] transition-all"
                    style={{ width: `${upload.status === 'assembling' ? 100 : progress}%` }}
                    role="progressbar"
                    aria-valuenow={progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Tiến độ tải lên"
                  />
                </div>
                <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                  {upload.status === 'assembling'
                    ? 'Đang ghép và kiểm tra tệp…'
                    : `Đã gửi ${upload.completedChunks}/${upload.totalChunks} phần (${progress}%)`}
                </p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => void cancelUpload()}>
                  Huỷ
                </Button>
              </div>
            ) : upload.status === 'done' ? (
              <p className="flex items-center gap-2 text-sm text-[var(--color-success)]">
                <CheckCircle2 className="h-4 w-4" />
                Tải lên hoàn tất ({formatBytes(upload.completed?.sizeBytes ?? file.size)})
              </p>
            ) : upload.status === 'error' ? (
              <div className="space-y-2">
                <p role="alert" className="text-sm text-[var(--color-destructive)]">
                  {upload.error}
                </p>
                {/* Retrying reuses the existing session, so chunks already
                    accepted are not re-sent. */}
                <Button size="sm" onClick={() => void startUpload()}>
                  Thử lại
                </Button>
              </div>
            ) : (
              <Button className="gap-2" onClick={() => void startUpload()}>
                <UploadIcon className="h-4 w-4" />
                Bắt đầu tải lên
              </Button>
            )}
          </CardContent>
        </Card>
      )}

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

          <label className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-3 text-sm">
            <input
              type="checkbox"
              checked={form.confirmed}
              onChange={(event) => setForm({ ...form, confirmed: event.target.checked })}
              className="mt-0.5 h-4 w-4"
            />
            <span>
              Tôi xác nhận tài liệu này không vi phạm bản quyền và tôi có quyền chia sẻ nó.
              <span className="mt-1 block text-xs text-[var(--color-muted-foreground)]">
                Tài liệu vi phạm sẽ bị gỡ bỏ và tài khoản có thể bị tạm ngưng.
              </span>
            </span>
          </label>

          {upload.status === 'error' && upload.completed ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {upload.error}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button disabled={!canPublish} onClick={() => void publish()}>
              Đăng tài liệu
            </Button>
            {!canPublish ? (
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {upload.status !== 'done'
                  ? 'Hoàn tất tải tệp trước.'
                  : 'Điền tiêu đề, khoa, loại tài liệu và xác nhận bản quyền.'}
              </span>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {upload.completed ? (
        <p className="mt-4 text-xs text-[var(--color-muted-foreground)]">
          Mã kiểm tra tệp: <code className="font-mono">{upload.completed.contentHash.slice(0, 16)}…</code>
          <Badge variant="outline" className="ml-2">
            {upload.completed.fileKind}
          </Badge>
        </p>
      ) : null}
    </div>
  );
}
