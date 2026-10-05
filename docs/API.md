# API — TAILIEU TTN

Tất cả endpoint nằm dưới `/api/v1/`, trừ health check ở `/api/health`.

**Định dạng phản hồi thống nhất** cho mọi endpoint:

```json
{ "success": true, "data": {}, "message": null, "meta": {} }
```

```json
{ "success": false, "error": { "code": "DOCUMENT_NOT_FOUND", "message": "..." } }
```

`error.code` là giá trị ổn định để lập trình; `message` để hiển thị và có thể đổi.

---

## Health

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/health` | Công khai |
| GET | `/api/health/db` | Chỉ quản trị (production) |
| GET | `/api/health/redis` | Chỉ quản trị (production) |
| GET | `/api/health/storage` | Chỉ quản trị (production) |

> Các endpoint chi tiết bị giới hạn: để lộ `storage: down` cho người lạ là thông tin trinh sát.


## Auth

| Method | Path | Xác thực |
|---|---|---|
| POST | `/api/v1/auth/register` | Công khai |
| POST | `/api/v1/auth/login` | Công khai |
| POST | `/api/v1/auth/refresh` | Công khai |
| POST | `/api/v1/auth/logout` | Đăng nhập |
| POST | `/api/v1/auth/logout-all` | Đăng nhập |
| GET | `/api/v1/auth/sessions` | Đăng nhập |
| DELETE | `/api/v1/auth/sessions/:id` | Đăng nhập |
| GET | `/api/v1/auth/me` | Đăng nhập |
| POST | `/api/v1/auth/email/verify` | Công khai |
| POST | `/api/v1/auth/email/resend` | Đăng nhập |
| POST | `/api/v1/auth/password/forgot` | Công khai |
| POST | `/api/v1/auth/password/reset` | Công khai |

## Documents

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/v1/documents/moderation/queue` | Công khai |
| GET | `/api/v1/documents/` | Tùy chọn |
| GET | `/api/v1/documents/tags` | Tùy chọn |
| GET | `/api/v1/documents/:id` | Tùy chọn |
| GET | `/api/v1/documents/:id/ratings` | Tùy chọn |
| POST | `/api/v1/documents/` | Đăng nhập + `documents.upload` |
| PATCH | `/api/v1/documents/:id` | Đăng nhập + `documents.update` |
| DELETE | `/api/v1/documents/:id` | Đăng nhập + `documents.delete` |
| GET | `/api/v1/documents/:id/download` | Tùy chọn |
| GET | `/api/v1/documents/:id/preview` | Tùy chọn |
| POST | `/api/v1/documents/:id/ratings` | Đăng nhập + `documents.rate` |
| DELETE | `/api/v1/documents/:id/ratings` | Đăng nhập + `documents.rate` |
| POST | `/api/v1/documents/:id/moderate` | Đăng nhập + `documents.moderate` |

## Search

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/v1/search/` | Tùy chọn |
| GET | `/api/v1/search/suggest` | Tùy chọn |
| GET | `/api/v1/search/info` | Công khai |
| GET | `/api/v1/search/health` | Công khai |
| POST | `/api/v1/search/reindex` | Đăng nhập + `search.reindex` |

## Taxonomy

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/v1/taxonomy/tree` | Công khai |
| GET | `/api/v1/taxonomy/faculties` | Công khai |
| GET | `/api/v1/taxonomy/faculties/:id` | Công khai |
| GET | `/api/v1/taxonomy/programs` | Công khai |
| GET | `/api/v1/taxonomy/programs/:id` | Công khai |
| GET | `/api/v1/taxonomy/subjects` | Công khai |
| GET | `/api/v1/taxonomy/subjects/:id` | Công khai |
| GET | `/api/v1/taxonomy/courses` | Công khai |
| GET | `/api/v1/taxonomy/courses/:id` | Công khai |
| GET | `/api/v1/taxonomy/academic-years` | Công khai |
| GET | `/api/v1/taxonomy/semesters` | Công khai |
| GET | `/api/v1/taxonomy/document-types` | Công khai |
| POST | `/api/v1/taxonomy/faculties` | Công khai |
| PATCH | `/api/v1/taxonomy/faculties/:id` | Công khai |
| DELETE | `/api/v1/taxonomy/faculties/:id` | Công khai |
| POST | `/api/v1/taxonomy/programs` | Công khai |
| PATCH | `/api/v1/taxonomy/programs/:id` | Công khai |
| DELETE | `/api/v1/taxonomy/programs/:id` | Công khai |
| POST | `/api/v1/taxonomy/subjects` | Công khai |
| PATCH | `/api/v1/taxonomy/subjects/:id` | Công khai |
| DELETE | `/api/v1/taxonomy/subjects/:id` | Công khai |
| POST | `/api/v1/taxonomy/academic-years` | Công khai |
| PATCH | `/api/v1/taxonomy/academic-years/:id` | Công khai |
| POST | `/api/v1/taxonomy/semesters` | Công khai |
| PATCH | `/api/v1/taxonomy/semesters/:id` | Công khai |
| POST | `/api/v1/taxonomy/courses` | Công khai |
| PATCH | `/api/v1/taxonomy/courses/:id` | Công khai |
| POST | `/api/v1/taxonomy/document-types` | Công khai |
| PATCH | `/api/v1/taxonomy/document-types/:id` | Công khai |

## Uploads

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/v1/uploads/allowed-types` | Công khai |
| GET | `/api/v1/uploads/active` | Công khai |
| POST | `/api/v1/uploads/` | Đăng nhập + `documents.upload` |
| GET | `/api/v1/uploads/:id` | Công khai |
| PUT | `/api/v1/uploads/:id/chunks/:index` | Đăng nhập + `documents.upload` |
| POST | `/api/v1/uploads/:id/complete` | Đăng nhập + `documents.upload` |
| DELETE | `/api/v1/uploads/:id` | Công khai |

---

Tổng cộng **70 endpoint**.



### Phân trang

Danh sách nhận `?page=` (mặc định 1) và `?limit=` (mặc định 20, **tối đa 100**).
Vượt giới hạn trả `422` thay vì âm thầm cắt bớt.

Số lượng nằm trong `meta`:

```json
{ "page": 2, "limit": 20, "total": 37, "totalPages": 2, "hasNext": false, "hasPrev": true }
```

### Mã lỗi thường gặp

| HTTP | Ý nghĩa |
|---|---|
| 400 | Yêu cầu không hợp lệ |
| 401 | Chưa xác thực, hoặc token hết hạn |
| 403 | Đã xác thực nhưng thiếu quyền |
| 404 | Không tồn tại **hoặc** không có quyền xem |
| 409 | Xung đột (trùng mã, đã kiểm duyệt) |
| 413 | Tệp quá lớn |
| 415 | Định dạng tệp không được hỗ trợ |
| 422 | Dữ liệu không khớp lược đồ — có chi tiết theo từng trường |
| 429 | Vượt giới hạn tần suất |
| 503 | Dịch vụ phụ thuộc không khả dụng |

> **404 chứ không phải 403** khi tài nguyên tồn tại nhưng người dùng không được
> xem. Trả 403 sẽ xác nhận tài nguyên đó tồn tại — bản thân điều đó đã là rò rỉ
> thông tin.

### Lỗi kiểm tra dữ liệu

`422` kèm chi tiết theo từng trường để giao diện đánh dấu đúng ô nhập liệu:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body is not valid.",
    "details": { "fields": { "password": ["Mật khẩu phải có ít nhất 10 ký tự."] } }
  }
}
```

### Tải lên theo phần

Tải tệp lớn dùng ba bước (bắt buộc vì Cloudflare giới hạn 100MB mỗi request):

1. `POST /api/v1/uploads` — khai báo tên, kích thước, loại → nhận `uploadId`, `chunkSize`, `totalChunks`
2. `PUT /api/v1/uploads/:id/chunks/:index` — thân là **nhị phân thô** (`application/octet-stream`), không phải multipart
3. `POST /api/v1/uploads/:id/complete` — ghép, kiểm tra, khử trùng lặp

`GET /api/v1/uploads/:id` trả danh sách phần đã nhận, cho phép **tiếp tục** sau khi
mất kết nối mà không phải gửi lại từ đầu.

### Về cột "Xác thực"

Cột này được sinh tự động từ khai báo route:

- **Công khai** — không cần đăng nhập
- **Tùy chọn** — không bắt buộc đăng nhập, nhưng người đã đăng nhập **thấy nhiều
  hơn** (tài liệu `internal`, tài liệu của chính họ). Đây là khác biệt quan trọng,
  không phải chi tiết hình thức.
- **Đăng nhập** — bắt buộc có token hợp lệ
- **Đăng nhập + `quyền`** — bắt buộc có token **và** quyền tương ứng

> Cột này chỉ mang tính tham khảo. **Mã nguồn route là nguồn sự thật** — đặc biệt
> khi có thay đổi, hãy đọc `backend/src/modules/*/*.route.ts`.

### Xem trước

`GET /api/v1/documents/:id/preview` trả về mô tả, kèm URL có chữ ký **nếu xem trước
được ngay**. Khác với `download`: tải xuống luôn tạo ra tệp, còn xem trước có thể
hợp lệ mà không có gì để hiển thị.

```json
{
  "kind": "office",
  "inline": true,
  "conversion": "ready",
  "url": "https://...",
  "expiresInSeconds": 120,
  "reason": null
}
```

`kind` là một trong `pdf`, `image`, `text`, `office`, `none`.
`conversion` là `not_needed`, `pending`, `ready`, `failed`, hoặc `unsupported`.

---

Tổng cộng **70 endpoint**.

## Quy ước chung

### Phân trang

Danh sách nhận `?page=` (mặc định 1) và `?limit=` (mặc định 20, **tối đa 100**).
Vượt giới hạn trả `422` thay vì âm thầm cắt bớt.

Số lượng nằm trong `meta`:

```json
{ "page": 2, "limit": 20, "total": 37, "totalPages": 2, "hasNext": false, "hasPrev": true }
```

### Mã lỗi thường gặp

| HTTP | Ý nghĩa |
|---|---|
| 400 | Yêu cầu không hợp lệ |
| 401 | Chưa xác thực, hoặc token hết hạn |
| 403 | Đã xác thực nhưng thiếu quyền |
| 404 | Không tồn tại **hoặc** không có quyền xem |
| 409 | Xung đột (trùng mã, đã kiểm duyệt) |
| 413 | Tệp quá lớn |
| 415 | Định dạng tệp không được hỗ trợ |
| 422 | Dữ liệu không khớp lược đồ — có chi tiết theo từng trường |
| 429 | Vượt giới hạn tần suất |
| 503 | Dịch vụ phụ thuộc không khả dụng |

> **404 chứ không phải 403** khi tài nguyên tồn tại nhưng người dùng không được
> xem. Trả 403 sẽ xác nhận tài nguyên đó tồn tại — bản thân điều đó đã là rò rỉ
> thông tin.

### Lỗi kiểm tra dữ liệu

`422` kèm chi tiết theo từng trường để giao diện đánh dấu đúng ô nhập liệu:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body is not valid.",
    "details": { "fields": { "password": ["Mật khẩu phải có ít nhất 10 ký tự."] } }
  }
}
```

### Tải lên theo phần

Tải tệp lớn dùng ba bước (bắt buộc vì Cloudflare giới hạn 100MB mỗi request):

1. `POST /api/v1/uploads` — khai báo tên, kích thước, loại → nhận `uploadId`, `chunkSize`, `totalChunks`
2. `PUT /api/v1/uploads/:id/chunks/:index` — thân là **nhị phân thô** (`application/octet-stream`), không phải multipart
3. `POST /api/v1/uploads/:id/complete` — ghép, kiểm tra, khử trùng lặp

`GET /api/v1/uploads/:id` trả danh sách phần đã nhận, cho phép **tiếp tục** sau khi
mất kết nối mà không phải gửi lại từ đầu.

### Về cột "Xác thực"

Cột này được sinh tự động từ khai báo route:

- **Công khai** — không cần đăng nhập
- **Tùy chọn** — không bắt buộc đăng nhập, nhưng người đã đăng nhập **thấy nhiều
  hơn** (tài liệu `internal`, tài liệu của chính họ). Đây là khác biệt quan trọng,
  không phải chi tiết hình thức.
- **Đăng nhập** — bắt buộc có token hợp lệ
- **Đăng nhập + `quyền`** — bắt buộc có token **và** quyền tương ứng

> Cột này chỉ mang tính tham khảo. **Mã nguồn route là nguồn sự thật** — đặc biệt
> khi có thay đổi, hãy đọc `backend/src/modules/*/*.route.ts`.

### Xem trước

`GET /api/v1/documents/:id/preview` trả về mô tả, kèm URL có chữ ký **nếu xem trước
được ngay**. Khác với `download`: tải xuống luôn tạo ra tệp, còn xem trước có thể
hợp lệ mà không có gì để hiển thị.

```json
{
  "kind": "office",
  "inline": true,
  "conversion": "ready",
  "url": "https://...",
  "expiresInSeconds": 120,
  "reason": null
}
```

`kind` là một trong `pdf`, `image`, `text`, `office`, `none`.
`conversion` là `not_needed`, `pending`, `ready`, `failed`, hoặc `unsupported`.

---

## Cộng đồng

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/v1/posts` | Tuỳ chọn |
| POST | `/api/v1/posts` | Đăng nhập |
| GET | `/api/v1/posts/:id` | Tuỳ chọn |
| PATCH | `/api/v1/posts/:id` | Đăng nhập (tác giả) |
| DELETE | `/api/v1/posts/:id` | Đăng nhập (tác giả hoặc quản trị) |
| GET | `/api/v1/comments` | Tuỳ chọn |
| POST | `/api/v1/comments` | Đăng nhập |
| PATCH | `/api/v1/comments/:id` | Đăng nhập (tác giả) |
| DELETE | `/api/v1/comments/:id` | Đăng nhập (tác giả hoặc kiểm duyệt viên) |
| PUT | `/api/v1/likes/:target/:id` | Đăng nhập |
| GET | `/api/v1/likes/:target/:id` | Tuỳ chọn |
| PUT | `/api/v1/follows/:userId` | Đăng nhập |
| GET | `/api/v1/bookmarks` | Đăng nhập |
| PUT | `/api/v1/bookmarks/:target/:id` | Đăng nhập |
| GET | `/api/v1/notifications` | Đăng nhập |
| GET | `/api/v1/notifications/unread-count` | Đăng nhập |

`target` là một trong `document`, `post`, `collection`. Like và bookmark dùng
`PUT { "liked": true }` / `{ "bookmarked": true }` — nêu rõ trạng thái mong muốn
thay vì đảo trạng thái, để một request được thử lại không tự huỷ chính nó.

### Bộ sưu tập

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/v1/collections` | Tuỳ chọn |
| GET | `/api/v1/collections/mine` | Đăng nhập |
| POST | `/api/v1/collections` | Đăng nhập (`collections.create`) |
| GET | `/api/v1/collections/:id` | Tuỳ chọn |
| PATCH | `/api/v1/collections/:id` | Đăng nhập (chủ sở hữu) |
| DELETE | `/api/v1/collections/:id` | Đăng nhập (chủ sở hữu hoặc `collections.moderate`) |
| POST | `/api/v1/collections/:id/items` | Đăng nhập (chủ sở hữu) |
| DELETE | `/api/v1/collections/:id/items/:itemId` | Đăng nhập (chủ sở hữu hoặc `collections.moderate`) |
| PATCH | `/api/v1/collections/:id/items/order` | Đăng nhập (chủ sở hữu) |

**`itemCount` trong phản hồi là số mục *người đang xem* được phép thấy**, không
phải tổng số hàng trong bộ sưu tập. Bộ sưu tập công khai có chứa một tài liệu
riêng tư sẽ báo `1` cho chủ sở hữu và `0` cho người khác — con số luôn khớp với
danh sách ngay bên dưới nó. Cột `collections.item_count` trong cơ sở dữ liệu vẫn
giữ tổng thật và được đối chiếu bởi `findCounterDrift()`.

Một mục chỉ được thêm vào nếu người thêm **đang** xem được nội dung đó. Nếu không,
API trả `404` — không phải `403`, vì `403` sẽ xác nhận id đó tồn tại.

Bộ sưu tập riêng tư của người khác cũng trả `404` cho cùng lý do.

### Nội dung đã bị xoá

Bình luận bị xoá (bởi tác giả hoặc bởi kiểm duyệt viên) vẫn giữ chỗ trong luồng:
`deleted: true`, `body: ""`, `author.id: ""`. Các trả lời bên dưới vẫn hiển thị.
Bản thân bình luận đã xoá không trả về hành động nào và không thể trả lời tiếp.

### Xếp thứ tự mục trong bộ sưu tập

`PATCH /api/v1/collections/:id/items/order` nhận `{ "itemIds": [...] }`. Các id
được đưa lên đầu theo đúng thứ tự gửi, **phần còn lại giữ nguyên vị trí tương
đối** — nên một danh sách thiếu (do phân trang) vẫn cho kết quả xác định. Id
không thuộc bộ sưu tập này bị bỏ qua, không báo lỗi.
