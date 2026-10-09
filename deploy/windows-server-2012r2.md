# Hướng Dẫn Vận Hành & Triển Khai Trên Windows Server 2012 R2

Tài liệu này cung cấp hướng dẫn chi tiết dành cho quản trị viên khi vận hành Backend **Tài Liệu Sinh Viên** trên hệ điều hành **Windows Server 2012 R2 (PowerShell 4.0 / cmd.exe)**.

---

## 1. Môi Trường & Yêu Cầu Kỹ Thuật

Trên Windows Server 2012 R2, các dịch vụ không chạy qua Docker mà chạy dạng dịch vụ Windows bản địa (Native Windows Services):

| Thành phần | Cấu hình khuyến nghị | Cách quản lý trên Windows Server 2012 R2 |
| :--- | :--- | :--- |
| **Node.js** | LTS (v18.x hoặc v20.x + VC++ Redistributable 2015–2022) | Cài đặt MSI, kiểm tra bằng `node -v` và `npm -v` |
| **PostgreSQL** | PostgreSQL 14+ x64 for Windows | Windows Service `postgresql-x64-16` trên `127.0.0.1:5432` |
| **Redis** | Redis for Windows / Memurai | Windows Service `Redis` trên `127.0.0.1:6379` |
| **PowerShell** | PowerShell 4.0 (mặc định) | Scripts trong `scripts/windows/` tương thích 100% |
| **NSSM** | NSSM 2.24 (Non-Sucking Service Manager) | Quản lý tiến trình Node.js thành Windows Service |

---

## 2. Quản Lý Chế Độ Bảo Trì (Maintenance Mode)

Khi có sự cố bản quyền hoặc cần bảo trì hệ thống, quản trị viên có thể bật/tắt chế độ bảo trì trực tiếp từ PowerShell hoặc Command Prompt:

### Cách 1: Qua lệnh NPM (khuyến nghị)
```cmd
:: Xem trạng thái hiện tại
npm run maintenance:status

:: Bật bảo trì (toàn bộ API công khai trả về 503)
npm run maintenance:on

:: Tắt bảo trì (mở lại website bình thường)
npm run maintenance:off
```

### Cách 2: Qua PowerShell 4.0 script
```powershell
.\scripts\windows\maintenance.ps1 -Action status
.\scripts\windows\maintenance.ps1 -Action on
.\scripts\windows\maintenance.ps1 -Action off
```

---

## 3. Rà Soát & Thanh Lọc Tài Liệu Vi Phạm Bản Quyền

Để kiểm tra và ẩn các tài liệu có dấu hiệu xâm phạm bản quyền giáo trình hoặc vi phạm thương hiệu cũ:

### Bước 1: Rà soát danh sách (Audit)
```cmd
npm run purge:audit
```
*Lệnh này chỉ đọc dữ liệu và in ra danh sách tài liệu vi phạm, không thay đổi dữ liệu.*

### Bước 2: Thực thi ẩn & lưu trữ (Purge)
```cmd
npm run purge:run
```
*Lệnh này sẽ soft-delete (`deleted_at = NOW(), status = 'archived'`) và khóa danh mục `textbook`.*

---

## 4. Cài Đặt Dịch Vụ Tự Khởi Động Bằng NSSM (Khuyến Nghị)

Để Backend Fastify tự động chạy khi máy chủ khởi động lại mà không cần mở Command Prompt:

1. Tải `nssm.exe` (bản 64-bit) và đặt vào `C:\Windows\System32\` hoặc thư mục tiện ích.
2. Mở Command Prompt (Run as Administrator) và chạy:
```cmd
nssm install TailieuApi "C:\Program Files\nodejs\node.exe" "C:\path\to\tailieu-web\backend\dist\server.js"
nssm set TailieuApi AppDirectory "C:\path\to\tailieu-web\backend"
nssm set TailieuApi AppEnvironmentExtra "NODE_ENV=production"
nssm set TailieuApi Start SERVICE_AUTO_START
```
3. Khởi động dịch vụ:
```cmd
nssm start TailieuApi
```
4. Kiểm tra trạng thái dịch vụ:
```cmd
nssm status TailieuApi
```

---

## 5. Quy Trình Tiếp Nhận DMCA / Gỡ Bỏ Tài Liệu (Notice & Takedown)

Khi nhận được email khiếu nại bản quyền gửi tới `admin@5125121.com`:

1. **Bước 1 (Xác định URL và ID tài liệu)**:
   Mở email, lấy URL tài liệu hoặc ID tài liệu (UUID).

2. **Bước 2 (Ẩn khẩn cấp tài liệu trong vòng 12–24h)**:
   Mở pgAdmin hoặc chạy SQL:
   ```sql
   UPDATE documents
   SET deleted_at = NOW(), status = 'archived'
   WHERE id = '<UUID-CỦA-TÀI-LIỆU>';
   ```
   *Tài liệu sẽ biến mất ngay lập tức khỏi giao diện người dùng và công cụ tìm kiếm.*

3. **Bước 3 (Phản hồi người khiếu nại)**:
   Gửi email xác nhận tới tác giả/giảng viên thông báo tài liệu đã được tạm ẩn và gỡ bỏ khỏi hệ thống theo chính sách Safe Harbor.
