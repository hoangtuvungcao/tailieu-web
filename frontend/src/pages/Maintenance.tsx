import { ShieldAlert, Wrench, Mail, Clock } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';

interface MaintenanceProps {
  onBypass?: () => void;
}

export function MaintenancePage({ onBypass }: MaintenanceProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--color-background)] p-4 text-[var(--color-foreground)]">
      <div className="w-full max-w-lg">
        <Card className="border-[var(--color-border)] shadow-xl text-center">
          <CardHeader className="space-y-4 pb-4">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 text-amber-500 ring-8 ring-amber-500/5">
              <Wrench className="h-8 w-8 animate-pulse" />
            </div>
            <div>
              <CardTitle className="text-2xl font-bold tracking-tight">
                Hệ Thống Đang Tạm Bảo Trì
              </CardTitle>
              <CardDescription className="mt-2 text-base text-[var(--color-muted-foreground)]">
                Nâng cấp hạ tầng và rà soát cơ sở dữ liệu học tập cộng đồng
              </CardDescription>
            </div>
          </CardHeader>

          <CardContent className="space-y-6 text-sm text-[var(--color-muted-foreground)]">
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/50 p-4 text-left space-y-2">
              <div className="flex items-center gap-2 font-medium text-[var(--color-foreground)]">
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                <span>Thông báo từ Ban Quản Trị</span>
              </div>
              <p className="leading-relaxed">
                Nhằm nâng cấp trải nghiệm người dùng và rà soát tính chuẩn mực của các nguồn học liệu theo quy định, website đang tạm đóng để bảo trì và tinh chỉnh dữ liệu.
              </p>
              <div className="flex items-center gap-2 pt-1 text-xs text-[var(--color-muted-foreground)]">
                <Clock className="h-3.5 w-3.5" />
                <span>Thời gian dự kiến hoàn tất: Sẽ có thông báo sớm nhất.</span>
              </div>
            </div>

            <p className="text-xs">
              Mọi thắc mắc, đóng góp ý kiến hoặc phản ánh nội dung, vui lòng gửi thư cho nhóm quản trị qua liên hệ bên dưới. Cảm ơn sự đồng hành và thông cảm của các bạn sinh viên!
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <a href="mailto:admin@5125121.com" className="w-full sm:w-auto">
                <Button variant="outline" className="w-full gap-2">
                  <Mail className="h-4 w-4" />
                  Liên hệ hỗ trợ
                </Button>
              </a>
              {onBypass && (
                <Button variant="ghost" size="sm" onClick={onBypass} className="text-xs opacity-40 hover:opacity-100">
                  Chế độ quản trị viên
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-[var(--color-muted-foreground)]">
          &copy; {new Date().getFullYear()} Nền tảng chia sẻ học thuật phi lợi nhuận.
        </p>
      </div>
    </div>
  );
}
