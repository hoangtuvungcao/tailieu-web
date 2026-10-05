# Hướng dẫn quản trị — TAILIEU TTN

Dành cho người vận hành nền tảng hằng ngày. Không giải thích kiến trúc — phần đó ở
[ARCHITECTURE.md](ARCHITECTURE.md). Ở đây chỉ nói **làm gì, bấm vào đâu, và khi nào
thì dừng lại**.

> Truy cập `/admin`. Chỉ hiện với người có vai trò phù hợp, nhưng đó chỉ là tiện
> ích — mọi thao tác đều được máy chủ kiểm tra lại quyền.

---

## 1. Vòng việc hằng ngày

Thứ tự này không tuỳ tiện: mỗi bước có thể tạo ra việc cho bước sau.

```
1. Hàng đợi báo cáo     ← người dùng phản ánh nội dung xấu
2. Tài liệu chờ duyệt   ← bài đăng cần người xem qua
3. Lưu trữ              ← phát hiện rò rỉ dung lượng
4. Nhật ký kiểm toán    ← chỉ khi có sự cố
```

### Bước 1 — Xử lý báo cáo

`/admin/reports` → tab **Chờ xử lý**, cũ nhất trước.

Với mỗi báo cáo:

| Nút | Khi nào dùng |
|---|---|
| **Xử lý** | Nội dung thật sự vi phạm. Ghi lý do — người đăng sẽ đọc nó. |
| **Bỏ qua** | Báo cáo sai hoặc nội dung hợp lệ. |

> **Luôn ghi lý do.** Báo cáo đã xử lý không sửa lại được, và "tại sao tài liệu
> của tôi bị gỡ" là câu hỏi sẽ đến. Một dòng ghi chú bây giờ tiết kiệm một email
> sau.

**Giới hạn đã biết:** một người chỉ mở được **một** báo cáo đang chờ cho mỗi nội
dung. Đây là chủ ý — bấm báo cáo hai mươi lần không tạo ra hai mươi việc. Sau khi
báo cáo được xử lý, cùng người đó báo lại cùng nội dung là **hợp lệ** ("nó vẫn còn
đó"), nên cơ chế này không nuốt mất tín hiệu đó.

### Bước 2 — Duyệt tài liệu

Tài liệu vào hàng đợi dựa trên **loại tài liệu**, không phải người đăng:

| Loại | Mặc định |
|---|---|
| Đề thi, đáp án, giáo trình | **Chờ duyệt** — nhóm này hay bị khiếu nại bản quyền |
| Bài giảng, bài tập, slide, mã nguồn… | Đăng ngay |

Đổi được ở `/admin/settings` → `uploads_require_review` (bắt duyệt **tất cả**) và
qua chính sách của từng loại tài liệu.

### Bước 3 — Kiểm tra lưu trữ

`/admin/storage`. Con số cần nhìn là **mồ côi** (đối tượng không tài liệu nào tham
chiếu).

```
mồ côi = 0        bình thường
mồ côi tăng dần   job dọn dẹp không chạy  ← hầu như luôn là nguyên nhân
```

Chạy tay:

```bash
cd backend
npm run cleanup                    # chỉ báo cáo, KHÔNG xoá
npm run cleanup -- --delete-orphans
```

> **Chạy `npm run cleanup` không có cờ trước, vài ngày liền.** Đọc con số. Chỉ khi
> nó hợp lý và ổn định mới thêm `--delete-orphans`. Đây là thao tác duy nhất trong
> hệ thống xoá dữ liệu người dùng thấy được, và `ref_count = 0` một mình **không
> đủ** để kết luận một đối tượng là rác — tệp vừa tải lên xong có thể đang chờ
> transaction gắn vào tài liệu commit.

### Bước 4 — Nhật ký kiểm toán

`/admin/audit-logs`. Dùng khi điều tra, không phải để đọc hằng ngày.

Lọc theo `action` để tìm nhanh:

| Hành động | Nghĩa |
|---|---|
| `auth.refresh_reuse_detected` | **Có người dùng lại token đã xoay vòng** — token bị đánh cắp, hoặc lỗi client |
| `admin.role.granted` / `.revoked` | Cấp/thu vai trò |
| `admin.user.suspended` | Đình chỉ tài khoản |
| `document.moderate.*` | Duyệt, từ chối, lưu trữ tài liệu |
| `document.file.infected` | **Phát hiện mã độc** trong tệp tải lên |

---

## 2. Quản lý người dùng

`/admin/users` → tìm theo tên hoặc email → **Chi tiết**.

### Cấp vai trò

| Vai trò | Quyền |
|---|---|
| Sinh viên | Mặc định cho mọi tài khoản |
| SV đã xác minh | Do kiểm duyệt viên cấp, **không tự gán được** |
| Giảng viên | Đăng tài liệu giảng dạy |
| **KĐV khoa** | Kiểm duyệt **trong một khoa** — phải chọn khoa khi cấp |
| Kiểm duyệt viên | Kiểm duyệt toàn hệ thống |
| Quản trị viên | Toàn quyền, trừ vài thao tác cấp cao |
| Quản trị tối cao | Không cấp được qua API |

Ba ràng buộc hệ thống **từ chối**, không phải lỗi:

- **Không cấp được `super_admin`** qua giao diện. Tài khoản admin bị chiếm cũng
  không tạo được một quản trị tối cao không xoá được.
- **Không thu hồi được quản trị viên cuối cùng.** Nếu không, hệ thống mất khả năng
  quản lý và cách duy nhất để sửa là vào thẳng database.
- **Không tác động được lên người ngang hoặc cao cấp hơn mình.** Một kiểm duyệt
  viên không đình chỉ được quản trị viên đang điều tra mình.

### KĐV khoa — chỗ dễ làm sai nhất

Cấp vai trò `faculty_moderator` **bắt buộc chọn khoa**. Bỏ trống sẽ bị từ chối.

Lý do: một KĐV khoa không có khoa là một cấp quyền toàn hệ thống mang tên "theo
khoa". Họ sẽ kiểm duyệt được tài liệu của mọi khoa.

**Kiểm chứng sau khi cấp:** đăng nhập bằng tài khoản đó, mở `/admin/reports`, xác
nhận chỉ thấy báo cáo thuộc khoa của họ.

### Đình chỉ tài khoản

Nút **Tạm ngưng** thu hồi **toàn bộ phiên** và vô hiệu hoá token đang dùng **ngay
lập tức**. Không có cửa sổ 15 phút nào để tài khoản bị đình chỉ tiếp tục hoạt động.

**Kích hoạt lại** không khôi phục phiên cũ — người dùng phải đăng nhập lại.

---

## 3. Cài đặt hệ thống

`/admin/settings`. Thay đổi có hiệu lực trong **~30 giây**, không cần khởi động lại.

### Trạng thái hệ thống

| Khoá | Tác dụng |
|---|---|
| `maintenance_mode` | Trả **503** cho mọi API. `/health` và đăng nhập **vẫn hoạt động** — nếu không, bạn tự khoá mình khỏi công tắc mở khoá. |
| `read_only_mode` | Chặn mọi thao tác ghi, vẫn cho đọc. Dùng khi sao lưu hoặc di chuyển dữ liệu. |
| `registration_enabled` | Đóng đăng ký tạm thời. |
| `upload_enabled` | Chặn tải lên mà không cần bảo trì. |

> **Bật `read_only_mode` trước khi sao lưu database.** `pg_dump` chạy trong khi có
> người đang ghi sẽ cho ra bản sao không nhất quán.

### Tải lên

`max_upload_bytes` (mặc định 2 GB), `uploads_require_review`.

> **Đừng đặt `max_upload_bytes` dưới 100MB** trừ khi bạn hiểu rõ. Cloudflare giới
> hạn 100MB mỗi request; tệp lớn đi qua proxy theo từng phần ~8MB nên giới hạn này
> là về tổng kích thước, không phải kích thước một request.

### Danh tiếng

`reputation_weights` — trọng số điểm và **trần dương mỗi ngày**. Trần này tồn tại
để chặn lạm dụng; nâng nó lên làm tăng giá trị của việc tạo tài khoản hàng loạt.

---

## 4. Danh mục

Màn hình **Danh mục** quản lý bảy loại dữ liệu nền: khoa, ngành, học phần, lớp học
phần, năm học, học kỳ và loại tài liệu. Mỗi loại là một tab; bảng và biểu mẫu dùng
chung một cách hiển thị nên thao tác giống nhau ở mọi tab.

- **Thêm** — nút góc trên bên phải. Trường có dấu `*` là bắt buộc.
- **Sửa** — biểu tượng bút chì ở cuối dòng.
- **Xoá** — biểu tượng thùng rác, hỏi xác nhận tại chỗ trước khi xoá.

**Mã (`code`) chỉ nhập được khi tạo, không sửa được.** Mã là thứ mà tài liệu cũ và
các dòng khác trỏ tới; đổi nó là di trú dữ liệu chứ không phải sửa một ô. API từ
chối trường này trong mọi lệnh cập nhật, và biểu mẫu cũng không hiện nó.

Một vài điều đáng biết:

- **Xoá là xoá mềm** ở hầu hết loại. Tài liệu đã gắn nhãn vẫn giữ nguyên nhãn đó.
- **Ngành chuyển được sang khoa khác.** Tài liệu cũ trỏ tới ngành bằng id, nên việc
  chuyển khoa không viết lại metadata của chúng.
- **Chính sách kiểm duyệt** của loại tài liệu quyết định tài liệu mới thuộc loại đó
  có phải chờ duyệt không. Đặt `Cần duyệt trước` là cách chặn một loại nội dung mà
  không phải tắt tải lên.
- Danh sách tải tối đa **100 mục** mỗi lần. Nếu còn mục chưa hiện, màn hình báo rõ số
  lượng — nhưng hiện chưa có phân trang.

Sửa danh mục sẽ tự làm mới bộ lọc khoa và loại tài liệu ở trang Tài liệu, nên không
cần tải lại trang.

---

## 5. Xử lý sự cố

### "Hệ thống đang bảo trì" mà tôi không bật

Ai đó đã bật `maintenance_mode`. Tắt ở `/admin/settings` — hoặc nếu không vào được
giao diện:

```bash
docker exec -i tailieu-postgres psql -U tailieu -d tailieu \
  -c "UPDATE settings SET value='false' WHERE key='maintenance_mode';"
```

### Ổ đĩa đầy dần

```bash
cd backend && npm run cleanup          # mồ côi nhiều?
docker exec tailieu-redis redis-cli llen scan:queue
docker exec tailieu-redis redis-cli llen preview:queue
```

Hàng đợi tăng mà không giảm nghĩa là worker chết. Xem `docs/DEPLOYMENT.md`.

### Tệp không bao giờ tải được, kẹt ở `pending`

**Quét virus đang bật và clamd không phản hồi.** Tệp chờ một phán quyết không bao
giờ đến.

```bash
docker logs tailieu-converter --tail 30 | grep -i scanner
docker exec tailieu-clamav clamdcheck.sh
docker exec tailieu-redis redis-cli llen scan:dead     # job bị bỏ
```

Đây là hành vi **đúng** — không xác minh được thì không phục vụ. Nhưng nó cần được
xử lý, không phải để nguyên: hàng đợi sẽ không tự khỏi.

### Xem trước tệp Word không bao giờ xong

Khác với trên — đây là lỗi **chuyển đổi**, không phải quét.

```bash
docker logs tailieu-converter --tail 30 | grep -iE "converting|converted|giving up"
```

### Người dùng báo bị đăng xuất liên tục

Tìm trong nhật ký kiểm toán:

```
action = auth.refresh_reuse_detected
```

Nếu có nhiều bản ghi từ **một người dùng**, hai khả năng:

1. **Token bị đánh cắp** — hệ thống đã làm đúng: thu hồi toàn bộ họ phiên và vô
   hiệu hoá token truy cập. Bảo người dùng đổi mật khẩu.
2. **Lỗi client** — một ứng dụng giữ token cũ và thử lại liên tục.

Nếu nhiều người dùng cùng lúc, nghi ngờ (2).

---

## 6. Việc định kỳ

| Việc | Tần suất | Ở đâu |
|---|---|---|
| Kiểm tra hàng đợi báo cáo | Hằng ngày | `/admin/reports` |
| Duyệt tài liệu chờ | Hằng ngày | Hàng đợi kiểm duyệt |
| Xem con số mồ côi | Hằng tuần | `/admin/storage` |
| Đọc nhật ký kiểm toán | Hằng tuần | `/admin/audit-logs` |
| **Thử khôi phục sao lưu** | **Hằng quý** | [DEPLOYMENT.md](DEPLOYMENT.md) |

> **Sao lưu chưa thử khôi phục thì chưa phải sao lưu.** Đây là việc duy nhất trong
> bảng mà bỏ qua sẽ không lộ ra cho tới ngày cần nhất.

---

## 7. Những việc KHÔNG làm

- **Không sửa database trực tiếp** trừ khi không còn đường khác. Mọi thay đổi qua
  giao diện đều sinh nhật ký kiểm toán; sửa tay thì không.
- **Không cấp `super_admin`** cho tài khoản dùng chung hay tài khoản thử nghiệm.
- **Không bật `--delete-orphans`** trước khi chạy báo cáo vài ngày.
- **Không tắt quét virus** để "cho nhanh". Nếu ClamAV quá nặng, giảm
  `SCAN_MAX_BYTES` — nhưng biết rằng tệp lớn hơn ngưỡng đó sẽ **không được phục vụ**,
  vì "không kiểm tra được" không giống "an toàn".

---

## 8. Giới hạn đã biết

| | |
|---|---|
| **Danh mục chỉ tải 100 mục mỗi lần** | API giới hạn 100 mục/trang; màn hình **Danh mục** báo rõ khi còn mục chưa hiện, nhưng chưa có phân trang |
| **Không gán giảng viên cho lớp học phần qua giao diện** | Trường `lecturerUserId` có trong API nhưng cần ô chọn người dùng; hiện để trống khi tạo lớp |
| **Không quản lý huy hiệu qua giao diện** | Huy hiệu do seed tạo; sửa tiêu chí phải chạy lại seed |
| **Không xem trước tệp trong hàng đợi kiểm duyệt** | Phải mở tài liệu ở tab khác |
| **Không có sao lưu tự động** | Hướng dẫn có trong DEPLOYMENT.md; phải tự đặt lịch |
