import { Layers, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { Badge, Button, Card, CardContent, EmptyState, ErrorState, Field, Input, Skeleton } from '@/components/ui';
import { ApiError } from '@/lib/api-client';
import {
  useCreateTaxonomy,
  useDeleteTaxonomy,
  useTaxonomyList,
  useUpdateTaxonomy,
  type TaxonomyEntity,
} from '@/lib/admin-hooks';
import { cn } from '@/lib/utils';
import { AdminPageHeader } from './AdminLayout';

/**
 * Taxonomy administration.
 *
 * Seven entities — faculties, programs, subjects, courses, academic years,
 * semesters, document types — over one table and one form, driven by the field
 * spec below. Seven bespoke screens would be seven copies of the same list,
 * the same validation wiring and the same delete confirmation, differing only
 * in which fields they read; this way a fix to any of them is a fix to all of
 * them.
 *
 * What that buys is paid for in type safety: the form works on
 * `Record<string, unknown>`, so a field name that does not exist server-side
 * would not be caught here. The spec is the only place that can be wrong, and
 * it is written to mirror `taxonomy.schema.ts` field for field.
 *
 * Every request is re-authorised server-side. The sidebar entry that hides this
 * page from a student is a convenience, not the control.
 */

// =============================================================================
// Field specs
// =============================================================================

type FieldType = 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'date';

interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: readonly { value: string; label: string }[];
  /** Resolved from another entity's list at render time. */
  optionsFrom?: 'faculties' | 'academic-years' | 'subjects' | 'semesters' | 'programs';
  maxLength?: number;
  hint?: string;
}

interface ColumnSpec {
  key: string;
  label: string;
  lookup?: 'faculties' | 'academic-years';
}

interface EntitySpec {
  key: TaxonomyEntity;
  label: string;
  description: string;
  columns: ColumnSpec[];
  /**
   * `code` is create-only on most entities: it is the stable identifier other
   * rows and historical documents point at, so editing it is a migration, not
   * an edit. The API agrees — `updateXSchema` omits it.
   */
  createFields: FieldSpec[];
  editFields: FieldSpec[];
}

const DEGREE_LEVELS = [
  { value: 'undergraduate', label: 'Đại học' },
  { value: 'postgraduate', label: 'Sau đại học' },
  { value: 'college', label: 'Cao đẳng' },
] as const;

const MODERATION_POLICIES = [
  { value: 'allowed', label: 'Cho phép' },
  { value: 'review_required', label: 'Cần duyệt trước' },
  { value: 'blocked', label: 'Chặn' },
] as const;

const short = { type: 'text', maxLength: 60 } as const;
const long = { type: 'textarea', maxLength: 2000 } as const;
const order = { type: 'number', label: 'Thứ tự', hint: 'Số nhỏ hiện trước.' } as const;
/** Spread into `editFields` only — nothing is created in the off state. */
const active = { key: 'isActive', type: 'checkbox', label: 'Đang dùng' } as const;

export const TAXONOMY_ENTITIES: EntitySpec[] = [
  {
    key: 'faculties',
    label: 'Khoa',
    description: 'Đơn vị cấp cao nhất trong phân loại tài liệu.',
    columns: [
      { key: 'code', label: 'Mã' },
      { key: 'name', label: 'Tên' },
      { key: 'shortName', label: 'Tên ngắn' },
      { key: 'sortOrder', label: 'Thứ tự' },
    ],
    createFields: [
      { key: 'code', label: 'Mã khoa', type: 'text', required: true, maxLength: 30 },
      { key: 'name', label: 'Tên khoa', type: 'text', required: true, maxLength: 200 },
      { key: 'shortName', ...short, label: 'Tên ngắn' },
      { key: 'description', ...long, label: 'Mô tả' },
      { key: 'sortOrder', ...order },
    ],
    editFields: [
      { key: 'name', label: 'Tên khoa', type: 'text', required: true, maxLength: 200 },
      { key: 'shortName', ...short, label: 'Tên ngắn' },
      { key: 'description', ...long, label: 'Mô tả' },
      { key: 'sortOrder', ...order },
      active,
    ],
  },
  {
    key: 'programs',
    label: 'Ngành',
    description: 'Ngành đào tạo, thuộc một khoa.',
    columns: [
      { key: 'code', label: 'Mã' },
      { key: 'name', label: 'Tên' },
      { key: 'facultyId', label: 'Khoa', lookup: 'faculties' },
      { key: 'degreeLevel', label: 'Bậc' },
    ],
    createFields: [
      { key: 'facultyId', label: 'Khoa', type: 'select', required: true, optionsFrom: 'faculties' },
      { key: 'code', label: 'Mã ngành', type: 'text', required: true, maxLength: 30 },
      { key: 'name', label: 'Tên ngành', type: 'text', required: true, maxLength: 200 },
      { key: 'shortName', ...short, label: 'Tên ngắn' },
      { key: 'degreeLevel', label: 'Bậc', type: 'select', options: DEGREE_LEVELS },
      { key: 'durationYears', label: 'Số năm', type: 'number' },
      { key: 'sortOrder', ...order },
    ],
    editFields: [
      // Moving a program between faculties is supported — historical documents
      // keep pointing at the program by id, so a move rewrites nothing.
      { key: 'facultyId', label: 'Khoa', type: 'select', optionsFrom: 'faculties' },
      { key: 'name', label: 'Tên ngành', type: 'text', required: true, maxLength: 200 },
      { key: 'shortName', ...short, label: 'Tên ngắn' },
      { key: 'degreeLevel', label: 'Bậc', type: 'select', options: DEGREE_LEVELS },
      { key: 'durationYears', label: 'Số năm', type: 'number' },
      { key: 'sortOrder', ...order },
      active,
    ],
  },
  {
    key: 'subjects',
    label: 'Học phần',
    description: 'Môn học dùng để gắn nhãn tài liệu.',
    columns: [
      { key: 'code', label: 'Mã' },
      { key: 'name', label: 'Tên' },
      { key: 'credits', label: 'Tín chỉ' },
    ],
    createFields: [
      { key: 'code', label: 'Mã học phần', type: 'text', required: true, maxLength: 30 },
      { key: 'name', label: 'Tên học phần', type: 'text', required: true, maxLength: 200 },
      { key: 'nameEn', label: 'Tên tiếng Anh', type: 'text', maxLength: 200 },
      { key: 'credits', label: 'Số tín chỉ', type: 'number' },
      { key: 'description', ...long, label: 'Mô tả' },
    ],
    editFields: [
      { key: 'name', label: 'Tên học phần', type: 'text', required: true, maxLength: 200 },
      { key: 'nameEn', label: 'Tên tiếng Anh', type: 'text', maxLength: 200 },
      { key: 'credits', label: 'Số tín chỉ', type: 'number' },
      { key: 'description', ...long, label: 'Mô tả' },
      active,
    ],
  },
  {
    key: 'academic-years',
    label: 'Năm học',
    description: 'Năm học và học kỳ trong năm.',
    columns: [
      { key: 'code', label: 'Mã' },
      { key: 'name', label: 'Tên' },
      { key: 'startsOn', label: 'Bắt đầu' },
      { key: 'endsOn', label: 'Kết thúc' },
    ],
    createFields: [
      { key: 'code', label: 'Mã năm học', type: 'text', required: true, hint: 'Dạng YYYY-YYYY, ví dụ 2025-2026.' },
      { key: 'name', label: 'Tên', type: 'text', required: true, maxLength: 200 },
      { key: 'startsOn', label: 'Ngày bắt đầu', type: 'date' },
      { key: 'endsOn', label: 'Ngày kết thúc', type: 'date' },
      { key: 'graduationYear', label: 'Năm tốt nghiệp', type: 'number' },
      { key: 'isCurrent', label: 'Đang diễn ra', type: 'checkbox' },
    ],
    editFields: [
      { key: 'name', label: 'Tên', type: 'text', required: true, maxLength: 200 },
      { key: 'startsOn', label: 'Ngày bắt đầu', type: 'date' },
      { key: 'endsOn', label: 'Ngày kết thúc', type: 'date' },
      { key: 'graduationYear', label: 'Năm tốt nghiệp', type: 'number' },
      { key: 'isCurrent', label: 'Đang diễn ra', type: 'checkbox' },
    ],
  },
  {
    key: 'semesters',
    label: 'Học kỳ',
    description: 'Học kỳ thuộc một năm học.',
    columns: [
      { key: 'code', label: 'Mã' },
      { key: 'name', label: 'Tên' },
      { key: 'academicYearId', label: 'Năm học', lookup: 'academic-years' },
      { key: 'termNo', label: 'Kỳ' },
    ],
    createFields: [
      { key: 'academicYearId', label: 'Năm học', type: 'select', required: true, optionsFrom: 'academic-years' },
      { key: 'termNo', label: 'Học kỳ số', type: 'number', required: true, hint: 'Từ 1 đến 6.' },
      { key: 'code', label: 'Mã học kỳ', type: 'text', required: true, maxLength: 20 },
      { key: 'name', label: 'Tên', type: 'text', required: true, maxLength: 200 },
      { key: 'startsOn', label: 'Ngày bắt đầu', type: 'date' },
      { key: 'endsOn', label: 'Ngày kết thúc', type: 'date' },
      { key: 'isCurrent', label: 'Đang diễn ra', type: 'checkbox' },
    ],
    editFields: [
      { key: 'name', label: 'Tên', type: 'text', required: true, maxLength: 200 },
      { key: 'startsOn', label: 'Ngày bắt đầu', type: 'date' },
      { key: 'endsOn', label: 'Ngày kết thúc', type: 'date' },
      { key: 'isCurrent', label: 'Đang diễn ra', type: 'checkbox' },
    ],
  },
  {
    key: 'document-types',
    label: 'Loại tài liệu',
    description: 'Phân loại tài liệu, kèm chính sách kiểm duyệt.',
    columns: [
      { key: 'code', label: 'Mã' },
      { key: 'name', label: 'Tên' },
      { key: 'moderationPolicy', label: 'Kiểm duyệt' },
    ],
    createFields: [
      { key: 'code', label: 'Mã loại', type: 'text', required: true, maxLength: 30 },
      { key: 'name', label: 'Tên loại', type: 'text', required: true, maxLength: 200 },
      { key: 'nameEn', label: 'Tên tiếng Anh', type: 'text', maxLength: 200 },
      { key: 'description', ...long, label: 'Mô tả' },
      { key: 'moderationPolicy', label: 'Chính sách kiểm duyệt', type: 'select', options: MODERATION_POLICIES },
      { key: 'sortOrder', ...order },
    ],
    editFields: [
      { key: 'name', label: 'Tên loại', type: 'text', required: true, maxLength: 200 },
      { key: 'nameEn', label: 'Tên tiếng Anh', type: 'text', maxLength: 200 },
      { key: 'description', ...long, label: 'Mô tả' },
      { key: 'moderationPolicy', label: 'Chính sách kiểm duyệt', type: 'select', options: MODERATION_POLICIES },
      { key: 'sortOrder', ...order },
      active,
    ],
  },
  {
    key: 'courses',
    label: 'Lớp học phần',
    description: 'Lớp học phần theo học kỳ.',
    columns: [
      { key: 'code', label: 'Mã' },
      { key: 'name', label: 'Tên' },
      { key: 'capacity', label: 'Sĩ số' },
    ],
    createFields: [
      { key: 'subjectId', label: 'Học phần', type: 'select', required: true, optionsFrom: 'subjects' },
      { key: 'semesterId', label: 'Học kỳ', type: 'select', required: true, optionsFrom: 'semesters' },
      { key: 'programId', label: 'Ngành', type: 'select', optionsFrom: 'programs' },
      { key: 'code', label: 'Mã lớp', type: 'text', required: true, maxLength: 40 },
      { key: 'name', label: 'Tên lớp', type: 'text', maxLength: 200 },
      { key: 'capacity', label: 'Sĩ số tối đa', type: 'number' },
    ],
    editFields: [
      { key: 'name', label: 'Tên lớp', type: 'text', maxLength: 200 },
      { key: 'capacity', label: 'Sĩ số tối đa', type: 'number' },
    ],
  },
];

// =============================================================================
// Page
// =============================================================================

export function AdminTaxonomyPage() {
  const [entityKey, setEntityKey] = useState<TaxonomyEntity>('faculties');
  const spec = TAXONOMY_ENTITIES.find((entry) => entry.key === entityKey)!;

  const query = useTaxonomyList(entityKey);

  // Reference lists for the `optionsFrom` lookups and for resolving an id to a
  // name in the table. Loaded regardless of the selected entity because they
  // are small and the administrator switches between entities freely.
  const faculties = useTaxonomyList('faculties');
  const academicYears = useTaxonomyList('academic-years');
  const programs = useTaxonomyList('programs');
  const subjects = useTaxonomyList('subjects');
  const semesters = useTaxonomyList('semesters');

  const lookups: Record<string, Record<string, unknown>[]> = {
    faculties: faculties.data?.items ?? [],
    'academic-years': academicYears.data?.items ?? [],
    programs: programs.data?.items ?? [],
    subjects: subjects.data?.items ?? [],
    semesters: semesters.data?.items ?? [],
  };

  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const rows = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  function label(row: Record<string, unknown>): string {
    return String(row.name ?? row.code ?? row.id);
  }

  return (
    <>
      <AdminPageHeader
        title="Danh mục"
        description="Khoa, ngành, học phần, năm học, học kỳ và loại tài liệu."
        actions={
          <Button size="sm" className="gap-2" onClick={() => { setCreating(true); setEditing(null); }}>
            <Plus className="h-4 w-4" aria-hidden />
            Thêm
          </Button>
        }
      />

      {/* Entity picker as a scroller, matching the admin sidebar's behaviour on
          narrow screens. */}
      <nav aria-label="Loại danh mục" className="-mx-4 mb-6 flex gap-1 overflow-x-auto px-4 pb-1">
        {TAXONOMY_ENTITIES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-pressed={entityKey === entry.key}
            onClick={() => {
              setEntityKey(entry.key);
              setEditing(null);
              setCreating(false);
            }}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium',
              entityKey === entry.key
                ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                : 'border-[var(--color-border)] text-[var(--color-muted-foreground)]',
            )}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <p className="mb-4 text-sm text-[var(--color-muted-foreground)]">{spec.description}</p>

      {creating || editing ? (
        <EntityForm
          spec={spec}
          row={editing}
          lookups={lookups}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      ) : null}

      {query.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : query.isError ? (
        <ErrorState
          message={
            query.error instanceof ApiError ? query.error.message : 'Đã xảy ra lỗi khi tải danh mục.'
          }
          onRetry={() => void query.refetch()}
        />
      ) : rows.length < total ? (
        // Never silent. The API caps a page at 100, and showing the first
        // hundred of three hundred without a word reads as "this is all of
        // them" — which is how somebody concludes a row they are looking for
        // does not exist.
        <p className="mb-3 text-xs text-[var(--color-warning,#b45309)]">
          Đang hiện {rows.length} / {total} mục. API giới hạn 100 mục mỗi lần tải; phần
          còn lại chưa có giao diện phân trang.
        </p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Layers className="h-8 w-8" />}
          title={`Chưa có ${spec.label.toLowerCase()} nào`}
          description="Bấm Thêm để tạo mục đầu tiên."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted-foreground)]">
                    {spec.columns.map((column) => (
                      <th key={column.key} className="px-4 py-2 font-medium">
                        {column.label}
                      </th>
                    ))}
                    <th className="px-4 py-2 text-right font-medium">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const id = String(row.id);
                    return (
                      <tr key={id} className="border-b border-[var(--color-border)] last:border-0">
                        {spec.columns.map((column) => (
                          <td key={column.key} className="px-4 py-2">
                            {renderCell(row, column, lookups)}
                          </td>
                        ))}
                        <td className="px-4 py-2">
                          <div className="flex items-center justify-end gap-1">
                            {confirmingId === id ? (
                              <>
                                <span className="text-xs text-[var(--color-muted-foreground)]">
                                  Xoá?
                                </span>
                                <DeleteButton entity={entityKey} id={id} onDone={() => setConfirmingId(null)} />
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 px-2 text-xs"
                                  onClick={() => setConfirmingId(null)}
                                >
                                  Huỷ
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  aria-label={`Sửa ${label(row)}`}
                                  onClick={() => {
                                    setEditing(row);
                                    setCreating(false);
                                  }}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-[var(--color-destructive)]"
                                  aria-label={`Xoá ${label(row)}`}
                                  onClick={() => setConfirmingId(id)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function renderCell(
  row: Record<string, unknown>,
  column: ColumnSpec,
  lookups: Record<string, Record<string, unknown>[]>,
): React.ReactNode {
  const value = row[column.key];

  if (column.lookup) {
    // Resolved from the loaded list rather than shown as a uuid — a column of
    // ids is technically accurate and useless.
    const match = (lookups[column.lookup] ?? []).find((entry) => entry.id === value);
    return match ? String(match.name ?? match.code) : '—';
  }

  if (typeof value === 'boolean') {
    return value ? <Badge variant="success">Có</Badge> : <span className="text-[var(--color-muted-foreground)]">Không</span>;
  }

  if (value === null || value === undefined || value === '') {
    return <span className="text-[var(--color-muted-foreground)]">—</span>;
  }

  return String(value);
}

function DeleteButton({
  entity,
  id,
  onDone,
}: {
  entity: TaxonomyEntity;
  id: string;
  onDone: () => void;
}) {
  const remove = useDeleteTaxonomy(entity);

  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs text-[var(--color-destructive)]"
        disabled={remove.isPending}
        onClick={() => remove.mutate(id, { onSuccess: onDone })}
      >
        {remove.isPending ? 'Đang xoá…' : 'Xoá'}
      </Button>
      {remove.isError ? (
        <span role="alert" className="text-xs text-[var(--color-destructive)]">
          {remove.error instanceof ApiError ? remove.error.message : 'Không xoá được.'}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Create or edit one row.
 *
 * The same component for both, because the two differ only in which fields the
 * spec lists — and `code`, absent from every `editFields`, is the one field the
 * API refuses to change.
 */
function EntityForm({
  spec,
  row,
  lookups,
  onClose,
}: {
  spec: EntitySpec;
  row: Record<string, unknown> | null;
  lookups: Record<string, Record<string, unknown>[]>;
  onClose: () => void;
}) {
  const creating = row === null;
  const fields = creating ? spec.createFields : spec.editFields;

  const create = useCreateTaxonomy(spec.key);
  const update = useUpdateTaxonomy(spec.key);
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      initial[field.key] = row?.[field.key] ?? (field.type === 'checkbox' ? false : '');
    }
    return initial;
  });

  function set(key: string, value: unknown): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();

    // Empty strings become null for optional fields: the API's `.nullish()`
    // fields treat null as "no value", and an empty string fails the min(1)
    // checks on the ones that are not optional.
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.key];
      if (value === '' && !field.required) {
        payload[field.key] = null;
        continue;
      }
      payload[field.key] = value;
    }

    if (creating) await create.mutateAsync(payload);
    else await update.mutateAsync({ id: String(row!.id), ...payload });

    onClose();
  }

  return (
    <Card className="mb-6">
      <CardContent className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">
            {creating ? `Thêm ${spec.label.toLowerCase()}` : `Sửa ${spec.label.toLowerCase()}`}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Đóng">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form className="space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={values[field.key]}
                lookups={lookups}
                onChange={(value) => set(field.key, value)}
              />
            ))}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-[var(--color-destructive)]">
              {error instanceof ApiError ? error.message : 'Không lưu được.'}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Đang lưu…' : 'Lưu'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function FieldInput({
  field,
  value,
  lookups,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  lookups: Record<string, Record<string, unknown>[]>;
  onChange: (value: unknown) => void;
}) {
  const id = `taxonomy-${field.key}`;
  const hint =
    field.required && !field.hint ? 'Bắt buộc' : (field.hint ?? (field.maxLength ? `Tối đa ${field.maxLength} ký tự.` : undefined));

  if (field.type === 'checkbox') {
    return (
      <label htmlFor={id} className="flex items-center gap-2 self-end pb-2 text-sm">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  }

  return (
    <Field label={field.label} htmlFor={id} hint={hint} required={field.required}>
      {field.type === 'textarea' ? (
        <textarea
          id={id}
          value={String(value ?? '')}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
          rows={3}
          className="w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 py-2 text-sm"
        />
      ) : field.type === 'select' ? (
        <select
          id={id}
          value={String(value ?? '')}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          className="h-10 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
        >
          <option value="">— Chọn —</option>
          {(field.optionsFrom ? lookups[field.optionsFrom] ?? [] : field.options ?? []).map((option) => {
            const optionValue = 'value' in option ? String(option.value) : String(option.id);
            const optionLabel = 'label' in option ? String(option.label) : String(option.name ?? option.code);
            return (
              <option key={optionValue} value={optionValue}>
                {optionLabel}
              </option>
            );
          })}
        </select>
      ) : (
        <Input
          id={id}
          type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
          value={String(value ?? '')}
          maxLength={field.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}
