import { ShieldCheck, Mail, Clock, AlertTriangle, FileText, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui';
import { useSeo } from '@/lib/seo';

export function CopyrightPolicyPage() {
  useSeo({
    title: 'Chính sách Bản quyền & Quy trình Gỡ bỏ (DMCA) — Tài Liệu Sinh Viên',
    description:
      'Chính sách sở hữu trí tuệ, bảo vệ bản quyền tác giả và quy trình tiếp nhận yêu cầu gỡ bỏ tài liệu (Notice and Takedown) của Tài Liệu Sinh Viên.',
  });

  return (
    <div className="container-page max-w-4xl py-10">
      {/* Header */}
      <div className="mb-8 border-b border-[var(--color-border)] pb-6">
        <div className="inline-flex items-center gap-2 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-600 dark:text-blue-400">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>Sở Hữu Trí Tuệ &amp; Bến Đỗ An Toàn</span>
        </div>
        <h1 className="mt-3 text-3xl font-bold tracking-tight">
          Chính Sách Bản Quyền &amp; Quy Trình Gỡ Bỏ (DMCA)
        </h1>
        <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
          Cập nhật lần cuối: Tháng 10/2026 • Áp dụng cho toàn bộ nội dung trên nền tảng Tài Liệu Sinh Viên.
        </p>
      </div>

      <div className="space-y-8 text-sm leading-relaxed text-[var(--color-muted-foreground)]">
        {/* 1. Tuyên bố chung */}
        <section className="space-y-3">
          <h2 className="text-xl font-bold text-[var(--color-foreground)]">
            1. Nguyên tắc hoạt động &amp; Tuyên bố miễn trừ
          </h2>
          <p>
            <strong>Tài Liệu Sinh Viên</strong> là nền tảng học thuật mở, phi lợi nhuận do nhóm sinh viên phát triển nhằm tạo không gian giao lưu, chia sẻ kinh nghiệm học tập và ghi chép cá nhân. Chúng tôi <strong>không thương mại hóa</strong> bất kỳ tài liệu hay ấn phẩm nào trên hệ thống.
          </p>
          <p>
            Nền tảng đóng vai trò là nhà cung cấp dịch vụ lưu trữ trung gian (theo quy định của Luật Sở hữu Trí tuệ Việt Nam và nguyên tắc Bến đỗ an toàn — <em>Safe Harbor / DMCA</em>). Chúng tôi tôn trọng quyền sở hữu trí tuệ của tất cả tác giả, giảng viên, các trường đại học và nhà xuất bản.
          </p>
        </section>

        {/* 2. Tiêu chuẩn nội dung được phép và bị cấm */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold text-[var(--color-foreground)]">
            2. Tiêu chuẩn nội dung học liệu
          </h2>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="border-emerald-500/20 bg-emerald-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base font-semibold text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Được khuyến khích chia sẻ
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs text-[var(--color-muted-foreground)]">
                <p>• Ghi chép cá nhân, tổng hợp bài học do sinh viên tự soạn.</p>
                <p>• Đề cương ôn tập tóm tắt kiến thức (Study summary / Cheatsheet).</p>
                <p>• Sơ đồ tư duy (Mindmap), bài tập tự luyện và lời giải tham khảo.</p>
                <p>• Mã nguồn, dự án mẫu, học liệu mở (Creative Commons / OER).</p>
              </CardContent>
            </Card>

            <Card className="border-rose-500/20 bg-rose-500/5">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base font-semibold text-rose-600 dark:text-rose-400">
                  <AlertTriangle className="h-4 w-4" />
                  Nghiêm cấm đăng tải
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 text-xs text-[var(--color-muted-foreground)]">
                <p>• Bản scan sách giáo trình, giáo trình thương mại có bản quyền.</p>
                <p>• Slide bài giảng nguyên gốc của thầy cô khi chưa có sự đồng ý.</p>
                <p>• Ngân hàng đề thi, đề thi nội bộ thuộc danh mục bảo mật của nhà trường.</p>
                <p>• Tài liệu chứa thông tin bí mật cá nhân hoặc mã độc.</p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* 3. Quy trình tiếp nhận & gỡ bỏ */}
        <section className="space-y-4">
          <h2 className="text-xl font-bold text-[var(--color-foreground)]">
            3. Quy trình tiếp nhận yêu cầu gỡ bỏ (Notice &amp; Takedown)
          </h2>
          <p>
            Nếu Quý Thầy/Cô, Tác giả, Nhà trường hoặc Chủ sở hữu quyền tác giả phát hiện tài liệu thuộc quyền sở hữu của mình xuất hiện trên website mà chưa được phép, vui lòng yêu cầu gỡ bỏ theo một trong hai cách:
          </p>

          <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-5">
            <h3 className="font-semibold text-[var(--color-foreground)]">
              Cách 1: Gửi yêu cầu trực tiếp trên trang tài liệu
            </h3>
            <p className="text-xs">
              Tại trang xem tài liệu, bấm nút <strong>"Báo cáo tài liệu vi phạm"</strong> và chọn lý do <em>"Vi phạm bản quyền"</em>.
            </p>

            <div className="border-t border-[var(--color-border)] pt-3">
              <h3 className="font-semibold text-[var(--color-foreground)]">
                Cách 2: Gửi thông báo bản quyền qua Email
              </h3>
              <p className="mt-1 text-xs">
                Gửi email tới địa chỉ tiếp nhận bản quyền:{' '}
                <a href="mailto:admin@5125121.com" className="font-medium text-[var(--color-primary)] underline">
                  admin@5125121.com
                </a>
              </p>
              <div className="mt-2 rounded bg-[var(--color-muted)] p-3 text-xs">
                <p className="font-medium text-[var(--color-foreground)]">Nội dung thông báo cần có:</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4">
                  <li>Đường dẫn (URL) cụ thể của tài liệu trên website cần gỡ bỏ.</li>
                  <li>Tên tác giả hoặc cơ quan/tổ chức sở hữu quyền tác giả.</li>
                  <li>Mô tả ngắn gọn hoặc tài liệu minh chứng quyền sở hữu tương ứng.</li>
                  <li>Thông tin liên hệ (Họ tên, email hoặc số điện thoại người đại diện).</li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* 4. Cam kết thời gian xử lý */}
        <section className="space-y-3">
          <h2 className="text-xl font-bold text-[var(--color-foreground)]">
            4. Cam kết thời gian phản hồi &amp; Xử lý vi phạm
          </h2>
          <div className="flex items-start gap-3 rounded-lg border border-blue-500/20 bg-blue-500/5 p-4 text-xs">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
            <div className="space-y-1">
              <p className="font-semibold text-blue-600 dark:text-blue-400">
                Cam kết tạm ẩn tài liệu trong vòng 12 – 24 giờ
              </p>
              <p>
                Ngay khi nhận được thông báo khiếu nại hợp lệ, đội ngũ quản trị sẽ lập tức <strong>tạm ẩn tài liệu khỏi hệ thống công khai</strong> để rà soát và xác minh. Nếu vi phạm được xác thực, tài liệu sẽ bị xóa vĩnh viễn khỏi máy chủ.
              </p>
            </div>
          </div>
        </section>

        {/* 5. Chính sách người vi phạm lặp lại */}
        <section className="space-y-3">
          <h2 className="text-xl font-bold text-[var(--color-foreground)]">
            5. Chính sách đối với tài khoản vi phạm tái diễn (Repeat Infringers)
          </h2>
          <p>
            Người dùng cố tình đăng tải tài liệu vi phạm bản quyền sau khi đã được nhắc nhở sẽ bị áp dụng các biện pháp:
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            <li>Khóa quyền tải lên tài liệu mới.</li>
            <li>Đình chỉ hoạt động tài khoản có thời hạn (7 – 30 ngày).</li>
            <li>Khóa tài khoản vĩnh viễn và cấm truy cập nếu tái phạm nhiều lần.</li>
          </ul>
        </section>

        {/* Contact CTA */}
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-6 text-center">
          <FileText className="mx-auto h-8 w-8 text-[var(--color-muted-foreground)]" />
          <h3 className="mt-2 text-base font-semibold text-[var(--color-foreground)]">
            Cần khiếu nại bản quyền hoặc hỗ trợ?
          </h3>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            Ban quản trị luôn sẵn sàng lắng nghe và phối hợp cùng các đơn vị giáo dục và quý thầy cô.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-3">
            <a href="mailto:admin@5125121.com?subject=[DMCA%20Notice]%20Yêu%20cầu%20gỡ%20bỏ%20tài%20liệu">
              <Button size="sm" className="gap-2">
                <Mail className="h-4 w-4" />
                Gửi yêu cầu gỡ bỏ bản quyền
              </Button>
            </a>
            <Link to="/documents">
              <Button variant="outline" size="sm">
                Quay lại kho tài liệu
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
