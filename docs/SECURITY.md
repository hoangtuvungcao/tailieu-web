# Mô hình bảo mật — TAILIEU TTN

Tài liệu này giải thích **các quyết định bảo mật và lý do** — không phải danh sách
tính năng. Mục đích là để người sửa mã sau này biết chỗ nào không được thay đổi
mà không hiểu vì sao nó như vậy.

---

## Nguyên tắc chung

1. **Backend là nơi duy nhất thực thi quyền.** Frontend ẩn nút chỉ để tránh hiện
   lỗi; nó không phải biện pháp kiểm soát. Mọi endpoint tự kiểm tra lại.
2. **Không tin dữ liệu từ client.** Tên tệp, `Content-Type`, `Content-Length`,
   vai trò, trạng thái — tất cả đều do client gửi và đều có thể sai.
3. **Thất bại theo hướng đóng.** Khi không chắc, từ chối. Khi lỗi, không rò rỉ.
4. **Không rò rỉ thông tin nội bộ.** Không stack trace, không câu SQL, không
   hostname, không lộ sự tồn tại của tài nguyên mà người dùng không được xem.

---

## 1. Xác thực

### Mật khẩu

- **Argon2id**: `m=65536` (64 MiB), `t=3`, `p=1`, đầu ra 32 byte.
- **Pepper** (`ARGON2_PEPPER`) nằm ngoài database. Kẻ tấn công lấy được dump
  database vẫn không tấn công offline được nếu không có pepper.
  → **Mất pepper là mất toàn bộ mật khẩu.** Sao lưu riêng, mã hoá.
- **`needsRehash` khi đăng nhập**: nâng cấp hash cũ lên tham số mới mà không cần
  bắt người dùng đổi mật khẩu. Đây là thời điểm duy nhất có mật khẩu gốc.
- **Chính sách mật khẩu**: tối thiểu 10 ký tự + danh sách đen. **Không** bắt buộc
  chữ hoa/số/ký tự đặc biệt — quy tắc đó đẩy người dùng tới `MatKhau1!` và làm
  giảm entropy thực tế.

### Chống dò tài khoản

Đăng nhập sai mật khẩu và đăng nhập vào tài khoản không tồn tại trả về **cùng
mã lỗi, cùng thông điệp**, và cùng thời gian phản hồi (`burnPasswordTime`). Nếu
không, thời gian phản hồi là một oracle dò tài khoản.

### Token truy cập (JWT)

- TTL **15 phút**, ký HS256, **thuật toán được ghim khi xác minh** — nếu không,
  token với `alg: none` có thể được chấp nhận.
- Chứa `{sub, sid, tv, roles}`. **Không chứa danh sách quyền**: quyền được giải
  quyết ở server mỗi request, nên thu hồi có hiệu lực ngay thay vì sau 15 phút.
- `tv` (token_version) đối chiếu với `users.token_version` mỗi request. Tăng giá
  trị này vô hiệu hoá **mọi** token truy cập còn hiệu lực — đây là công tắc ngắt
  toàn bộ phiên.

### Token làm mới (refresh)

- **Mờ (opaque)**, không phải JWT: cần tra database mỗi lần dùng để phát hiện
  việc dùng lại token đã xoay vòng.
- Chỉ lưu `sha256(raw)`. Rò rỉ database không cho kẻ tấn công token dùng được.
- **Chỉ trong cookie `httpOnly`, `SameSite=Lax`, `Path=/api/v1/auth`.**
  Không bao giờ trong body JSON, không bao giờ trong localStorage.
  `Path` hẹp để cookie không được gửi kèm mọi request API.

### Xoay vòng token và phát hiện dùng lại

Mỗi lần làm mới tạo một token mới và đánh dấu token cũ là `rotated_at`. Trình bày
một token **đã được xoay vòng** nghĩa là nó đã bị đánh cắp (client hợp lệ đang giữ
token kế nhiệm). Phản ứng:

1. Thu hồi **toàn bộ họ phiên** — mọi token con đều chết.
2. **Tăng `token_version`** — đây là phần dễ bỏ sót nhất. Chỉ thu hồi refresh
   token sẽ để token truy cập của kẻ tấn công sống thêm tới 15 phút.
3. Ghi `audit_logs` **trong cùng transaction** với việc thu hồi.

**Cửa sổ gia hạn (`REFRESH_GRACE_MS`, 10 giây):** hai tab cùng làm mới một lúc là
tình huống bình thường, không phải trộm cắp. Trong cửa sổ này, nếu token kế nhiệm
chưa bị xoay vòng, trả `409 AUTH_REFRESH_RACE` để client thử lại — **không** đăng
xuất người dùng thật.

> **Bài học từ lỗi thật:** phiên bản đầu thu hồi họ phiên *bên trong* transaction
> rồi ném lỗi, khiến Drizzle rollback và **xoá luôn việc thu hồi**. Kết quả: token
> truy cập chết nhưng refresh token bị đánh cắp vẫn dùng được — đúng ngược lại ý
> định. Phản ứng bảo mật nay chạy trong transaction riêng và commit trước khi báo lỗi.

### CSRF

Vì API cùng origin với frontend trong production, cookie làm mới **mở lại nguy cơ
CSRF** (§34 của đề bài không nhắc tới, nhưng đây là lỗ hổng thật).

Biện pháp: **double-submit**. Cookie `csrf` (đọc được bằng JS) phải khớp header
`X-CSRF-Token`. Kẻ tấn công cross-site khiến trình duyệt *gửi* cookie nhưng
**không đọc được** nó để đặt header.

Áp dụng cho mọi request thay đổi trạng thái dựa trên cookie. Miễn trừ: đăng nhập,
đăng ký, quên/đặt lại mật khẩu — chúng không dựa vào thẩm quyền từ cookie.

> **Không xoay vòng CSRF token khi refresh.** Đã thử và nó phá tab thứ hai: token
> trong tab kia trở nên cũ và request kế tiếp bị 403. CSRF token đã gắn với phiên;
> xoay vòng không thêm bảo vệ mà chỉ gây lỗi.

---

## 2. Phân quyền (RBAC)

- Danh mục quyền nằm trong `src/config/permissions.ts` — **mã nguồn là nguồn sự
  thật**, database chỉ phản chiếu. Nhờ vậy `authorize('sai.chinh.ta')` là lỗi biên
  dịch, không phải 403 im lặng.
- Quyền được cache trong Redis (TTL 300s) và **vô hiệu hoá bằng bộ đếm phiên bản**
  khi có thay đổi vai trò. Một lệnh `INCR` vô hiệu hoá toàn bộ cache.
- **Phân quyền theo khoa được thực thi trong SQL**, không phải bằng cách lọc kết
  quả trong JavaScript. `visibilityPredicate` và `listModerationQueue` đều thu hẹp
  theo `facultyIds` — các hàng không được phép xem thì **không bao giờ được nạp**.
- **Kiểm tra ghi là bắt buộc riêng.** Chỉ chặn đọc là không đủ: nếu không kiểm tra
  ghi, bất kỳ ai biết UUID đều có thể publish tài liệu của khoa khác.

> **Bài học từ lỗi thật:** `faculty_id = ANY($1::uuid[])` với mảng JavaScript một
> phần tử không tạo ra array literal hợp lệ — PostgreSQL báo `malformed array
> literal`. Phân quyền theo khoa **không hoạt động** ở đúng trường hợp chính của nó
> (kiểm duyệt viên phụ trách một khoa). Đã sửa bằng `inArray`. Có test hồi quy.

### Thứ hạng

Vai trò có `rank`. Không ai tác động được lên người có thứ hạng cao hơn — nếu
không, một admin có thể ban super admin đang điều tra mình.

---

## 3. Tệp tải lên

Đây là bề mặt tấn công lớn nhất.

### Kiểm tra loại tệp

- **Magic byte**, không phải phần mở rộng hay `Content-Type`. Cả hai đều do client
  kiểm soát và không chứng minh được gì.
- Nếu loại khai báo **mâu thuẫn** với byte thực tế → từ chối (415), trừ các cặp
  tương thích đã biết (`.docx` là ZIP; các định dạng Office cũ dùng chung OLE2).
- **Danh sách trắng**, không phải danh sách đen. Vắng mặt có chủ ý và không phải
  sơ suất:
  - `text/html` — phục vụ trong origin là stored XSS
  - `image/svg+xml` — XML mang được `<script>`
  - `application/javascript`, `.exe`, `.bat`, `.sh`
- Với định dạng văn bản thuần (không có chữ ký), **bắt buộc** phải vượt qua kiểm
  tra "trông giống văn bản" (không có byte NUL, >95% ký tự in được). Phần mở rộng
  một mình **không bao giờ** đủ.

### Kích thước và tài nguyên

- Giới hạn kích thước áp đặt **giữa luồng**, bằng cách đếm byte khi chúng đi qua —
  không tin `Content-Length` vì client có thể nói dối và chunked encoding không gửi.
- Mọi thứ **stream**. Không có chỗ nào đọc cả tệp vào bộ nhớ. Đây là điều giữ mức
  dùng bộ nhớ phẳng bất kể kích thước tệp.
- Mọi phần tải lên phải đúng kích thước đã khai báo; phần giữa bị hụt sẽ dịch
  chuyển toàn bộ byte phía sau và tạo ra tệp hỏng chỉ lộ ra khi mở.

### Lưu trữ

- **Khoá lưu trữ là UUID ngẫu nhiên**, không bao giờ từ tên tệp. Không đoán được,
  không liệt kê được.
- **Khoá không có phần mở rộng.** Tại thời điểm bắt đầu tải lên chưa biết loại
  thật; phần mở rộng đoán sai còn tệ hơn không có, vì nó đánh lừa người đọc sau này.
- **Liệt kê bucket bị từ chối** ở tầng lưu trữ. Biết một khoá không cho phép liệt
  kê các khoá khác.
- **`storage_objects.ref_count`** đếm số tham chiếu. Chỉ xoá byte khi về 0 — nếu
  không, xoá một tài liệu sẽ phá mọi tài liệu khác dùng chung nội dung.
- Tăng `ref_count` và chèn `document_files` **trong cùng một transaction**.

### Tải xuống

Không bao giờ lộ khoá lưu trữ. Mọi lần tải đi qua:

1. Kiểm tra quyền (cùng vị từ `visibilityPredicate` như đường đọc)
2. Sinh **URL có chữ ký, hết hạn sau 120 giây**
3. Ghi `download_events` và tăng bộ đếm

URL chứa đường dẫn đối tượng — điều này **không tránh được** với S3 presigned URL,
và chấp nhận được vì: khoá không đoán được, không liệt kê được, URL hết hạn nhanh.

### `Content-Disposition`

Tên tệp gốc được mã hoá theo **RFC 5987** (`filename*=UTF-8''...`) kèm bản ASCII
dự phòng. Không có bước này, tên tệp tiếng Việt sẽ hỏng khi tải về.

Chỉ định dạng nằm trong danh sách trắng mới được phục vụ `inline`; còn lại luôn
`attachment`, để tệp không bao giờ được hiểu là nội dung hoạt động trong origin
của site.

---

## 4. Cơ sở dữ liệu

- **Truy vấn tham số hoá** ở mọi nơi (Drizzle). Không nối chuỗi SQL.
- **Xoá mềm** với chỉ mục duy nhất **một phần** (`WHERE deleted_at IS NULL`). Chỉ
  mục duy nhất thường sẽ "đốt" giá trị sau khi xoá mềm — người dùng không tạo lại
  được email đã xoá.
- **Ngoại lệ: người dùng không bao giờ được xoá mềm để giải phóng email.** Nếu
  giải phóng, kẻ tấn công đăng ký lại địa chỉ của người đã rời đi và **thừa hưởng
  quyền tác giả** của họ. Tài khoản bị vô hiệu giữ nguyên email, hoặc được ẩn danh.
- **Khoá ngoại `RESTRICT`** cho taxonomy — không xoá được khoa còn ngành. Máy chủ
  từ chối trước cả khi logic ứng dụng chạy.
- **Soft delete + `is_active`**: `is_active` mới là công tắc thật.
- **`UNIQUE NULLS NOT DISTINCT`** cho `user_roles` — nếu không, `NULL != NULL` cho
  phép một người tích luỹ vô số bản cấp quyền trùng nhau.

---

## 5. Kiểm soát tần suất

Đều dựa trên Redis, nên dùng chung giữa các tiến trình.

| Endpoint | Giới hạn | Lý do |
|---|---|---|
| Đăng nhập (theo IP) | 10 / 15 phút | Argon2id tốn 64 MiB mỗi lần băm — 10 lần đồng thời là 640 MiB. Giới hạn bảo vệ tiến trình khỏi bị OOM bởi chính việc băm mật khẩu. |
| Đăng nhập (theo **tài khoản**) | 10 lần sai / 15 phút | Xem ghi chú bên dưới — đây mới là lớp chống dò mật khẩu thực sự. |
| Đăng ký | 5 / giờ | Chống tạo tài khoản hàng loạt; có gửi mail. |
| Quên mật khẩu | 5 / giờ | Chống dội mail vào người khác. |
| Tải lên | 100 / giờ (theo người dùng) | Đủ cho nhu cầu thật, chặn lạm dụng. |
| Chunk | 2000 / giờ | Một tệp lớn gửi rất nhiều phần; đây là chốt chặn, không phải chính sách. |
| Gợi ý | 360 / phút | Gõ một truy vấn là rất nhiều phím. |

Khoá theo **người dùng** khi đã xác thực, để một mạng NAT của trường không khiến
sinh viên này tiêu hết hạn mức của sinh viên khác.

### Giới hạn đăng nhập theo IP là KHÔNG ĐỦ

Một phát hiện thật, ghi lại vì nó trông như đã được xử lý mà thực ra không.

Fastify chạy `keyGenerator` của route **trước khi body được phân tích**. Nên
`keyGenerator` viết là `login:<ip>:<email>` thực chất chạy với `request.body`
là `undefined` và trở thành `login:<ip>:**anon**`. Log Redis cho thấy đúng như vậy.

Hệ quả: giới hạn đăng nhập chỉ còn **theo IP**. Kẻ tấn công dùng botnet hoặc dải
proxy — mỗi lần thử từ một địa chỉ khác — **vượt qua hoàn toàn**. Comment trong
`auth.route.ts` từng nói "một tài khoản không thể bị dò từ nhiều IP"; điều đó
**không đúng** với mã cũ.

**Đã sửa** bằng bộ đếm theo tài khoản trong `login-throttle.ts`, chạy sau khi đã
có body:

- Đếm **mọi** lần đăng nhập sai, kể cả địa chỉ không tồn tại. Chỉ đếm tài khoản
  thật sẽ biến việc bị khoá thành một oracle dò tài khoản — chính cái khoá lại
  tiết lộ địa chỉ nào đã đăng ký.
- Kiểm tra **trước khi** băm mật khẩu, nên tài khoản đã khoá tốn một lần đọc
  Redis thay vì 64 MiB Argon2.
- Đăng nhập thành công **xoá** chuỗi đếm — người gõ sai vài lần rồi đúng không
  bị khoá vì lịch sử cũ.
- Có TTL, nên khoá **tự mở**; `ttl = -1` sẽ là khoá vĩnh viễn.
- Redis hỏng thì **fail open** — đây là lớp thứ hai, và từ chối mọi đăng nhập vì
  cache hỏng còn tệ hơn mất tạm một lớp phòng vệ.

---

## 6. Ghi nhật ký kiểm toán

`audit_logs` ghi các hành động quản trị và bảo mật.

**Điểm quan trọng:** với hành động bảo mật, bản ghi được viết **trong cùng
transaction** với thay đổi mà nó mô tả. Ghi "best-effort" sau khi xong sẽ mất đúng
những sự kiện cần nhất — sự kiện mà transaction đổ vỡ giữa đường.

Ghi nhật ký: cấp/thu vai trò, kiểm duyệt, đăng xuất mọi thiết bị, phát hiện dùng
lại token, thay đổi taxonomy, xoá tài liệu.

**Không** ghi: xem tài liệu, tìm kiếm — khối lượng lớn mà giá trị điều tra thấp.

Không bao giờ chứa: mật khẩu, hash mật khẩu, giá trị token.

---

## 7. Tiêu đề bảo mật

| Tiêu đề | Giá trị |
|---|---|
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'; ...` |
| `X-Frame-Options` | `DENY` (khớp với CSP, không mâu thuẫn) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | Từ chối toàn bộ (API không cần camera, micro, vị trí…) |

CORS chỉ cho phép origin trong danh sách trắng; `*` bị **từ chối lúc khởi động**
(`env.ts`), vì `credentials: true` + wildcard là lỗ hổng.

---

## 8. Những điều CHƯA có

Trung thực về khoảng trống quan trọng hơn một danh sách kiểm tra toàn dấu tick.

| Thiếu | Rủi ro | Giảm thiểu hiện tại |
|---|---|---|
| **Quét virus** | Tài liệu độc hại (macro, PDF chứa JS) | Chỉ nhận định dạng trong danh sách trắng; ép `attachment` cho mọi thứ không xem trước được. Cột `scan_status` đã có sẵn. |
| **Xác thực email bắt buộc** | Tài khoản rác | Email xác minh được gửi nhưng không chặn đăng nhập. |
| **2FA/TOTP** | Chiếm tài khoản nếu lộ mật khẩu | Chưa có. |
| **Google OAuth** | — | Đã thiết kế (`auth_identities`), chưa bật. |
| **Giới hạn hạn ngạch theo người dùng** | Một người dùng làm đầy ổ đĩa | Bảng `storage_usage` có sẵn, chưa thực thi. |
| **Xoay vòng bí mật** | Bí mật cũ sống mãi | Chưa có quy trình. |

### Điểm cần rà soát định kỳ

- [ ] `ARGON2_PEPPER` đã sao lưu **tách riêng** và mã hoá chưa?
- [ ] Sao lưu database có **thực sự khôi phục được** không? (đã thử chưa?)
- [ ] Tài khoản mẫu `admin@tailieu.local` đã đổi mật khẩu chưa?
- [ ] `preview:dead` trong Redis có đang tăng không?
- [ ] `audit_logs` có sự kiện `auth.refresh_reuse_detected` bất thường không?
- [ ] Dung lượng `/var/backups` có bị đầy không?
