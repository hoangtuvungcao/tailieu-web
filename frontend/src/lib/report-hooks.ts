import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiWithMeta } from './api-client';
import { useSessionSettled } from './auth';

/**
 * Report hooks.
 *
 * The counterpart to `admin-hooks.ts`, which reads and resolves the same
 * table. Before these existed the moderation queue could not fill: the table,
 * the queue screen and the resolve action were all built, and nothing anywhere
 * filed a report.
 */

/**
 * The reasons a reporter may choose, in the order they are offered.
 *
 * Vietnamese labels live here rather than in the component so the picker and
 * any future display of an existing report read the same words. The values are
 * the database enum; the labels are what a student would say.
 */
export const REPORT_REASONS = [
  { value: 'copyright', label: 'Vi phạm bản quyền' },
  { value: 'wrong_content', label: 'Nội dung sai hoặc không đúng mô tả' },
  { value: 'fake_document', label: 'Tài liệu giả mạo' },
  { value: 'malware', label: 'Có mã độc hoặc tệp nguy hiểm' },
  { value: 'spam', label: 'Spam hoặc quảng cáo' },
  { value: 'sensitive', label: 'Nội dung nhạy cảm' },
  { value: 'harassment', label: 'Quấy rối hoặc xúc phạm' },
  { value: 'misleading', label: 'Thông tin gây nhầm lẫn' },
  { value: 'other', label: 'Lý do khác' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['value'];

export type ReportTargetType = 'document' | 'post' | 'comment' | 'user' | 'collection';

export function reportReasonLabel(reason: string): string {
  return REPORT_REASONS.find((entry) => entry.value === reason)?.label ?? reason;
}

const TARGET_LABELS: Record<ReportTargetType, string> = {
  document: 'Tài liệu',
  post: 'Bài đăng',
  comment: 'Bình luận',
  user: 'Người dùng',
  collection: 'Bộ sưu tập',
};

export function reportTargetLabel(targetType: string): string {
  return TARGET_LABELS[targetType as ReportTargetType] ?? targetType;
}

export interface MyReport {
  id: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: 'pending' | 'reviewing' | 'resolved' | 'rejected';
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/**
 * Whether the signed-in viewer already has an open report on this target.
 *
 * Gated on the session settling, like every other request that needs to know
 * who is asking: firing it before the refresh token has been exchanged sends it
 * unauthenticated, and the 401 that comes back would be indistinguishable from
 * a real failure.
 */
export function useReportState(
  targetType: ReportTargetType,
  targetId: string | undefined,
  enabled = true,
) {
  const settled = useSessionSettled();

  return useQuery({
    queryKey: ['report-state', targetType, targetId],
    queryFn: () =>
      api.get<{ reported: boolean }>(
        `/reports/state?targetType=${targetType}&targetId=${encodeURIComponent(targetId!)}`,
      ),
    enabled: settled && enabled && Boolean(targetId),
  });
}

export function useCreateReport() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      targetType: ReportTargetType;
      targetId: string;
      reason: ReportReason;
      details?: string;
    }) => api.post<{ id: string; status: string }>('/reports', input),

    onSuccess: (_result, input) => {
      // Mark the button as used straight away rather than refetching. The
      // server is the authority on whether a report exists, but the answer is
      // already known here, and a round trip would leave the button live for a
      // moment after a successful send — which is exactly long enough for
      // someone to press it twice and collect a 409 for no reason.
      queryClient.setQueryData(['report-state', input.targetType, input.targetId], {
        reported: true,
      });
      void queryClient.invalidateQueries({ queryKey: ['my-reports'] });
    },
  });
}

export interface MyReportsPage {
  data: MyReport[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export function useMyReports(page = 1) {
  const settled = useSessionSettled();

  return useQuery({
    queryKey: ['my-reports', page],
    queryFn: async (): Promise<MyReportsPage> => {
      const { data, meta } = await apiWithMeta<MyReport[]>(
        `/reports/mine?page=${page}&limit=20`,
      );
      // `apiWithMeta` hands back the envelope's `meta` as an open record, so the
      // pagination fields have to be named here. Narrowing it once at the edge
      // beats every consumer casting the same four fields.
      return { data, meta: meta as unknown as MyReportsPage['meta'] };
    },
    enabled: settled,
  });
}
