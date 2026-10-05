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

## Admin

Mỗi endpoint dưới đây đòi một quyền cụ thể, không phải "là quản trị viên". Giữ
`analytics.read` cho phép xem dashboard và không gì khác. Quyền được kiểm tra ở
đây; việc giao diện ẩn một mục menu chỉ là hình thức.

| Method | Path | Xác thực |
|---|---|---|
| GET | `/api/v1/admin/stats` | `analytics.read` |
| GET | `/api/v1/admin/stats/timeseries` | `analytics.read` |
| GET | `/api/v1/admin/users` | `users.read` |
| GET | `/api/v1/admin/users/:id` | `users.read` |
| PATCH | `/api/v1/admin/users/:id` | `users.write` |
| POST | `/api/v1/admin/users/:id/roles` | `users.change_role` |
| DELETE | `/api/v1/admin/users/:id/roles/:roleId` | `users.change_role` |
| POST | `/api/v1/admin/users/:id/force-logout` | `users.force_logout` |
| GET | `/api/v1/admin/users/:id/sessions` | `users.read_sessions` |
| DELETE | `/api/v1/admin/users/:id/sessions/:sessionId` | `users.force_logout` |
| GET | `/api/v1/admin/roles` | `roles.manage` |
| GET | `/api/v1/admin/audit-logs` | `audit.read` |
| GET | `/api/v1/admin/storage` | `storage.manage` |
| GET | `/api/v1/admin/reports` | `reports.read` |
| POST | `/api/v1/admin/reports/:id/resolve` | `reports.resolve` |
| GET | `/api/v1/admin/settings` | `settings.manage` |
| PATCH | `/api/v1/admin/settings` | `settings.manage` |

Thao tác ghi bị giới hạn **60 lần/giờ cho mỗi người dùng** — một quản trị viên bấm
qua các màn hình sẽ không bao giờ đụng trần, còn một vòng lặp cấp quyền tự động
thì có.

> `PATCH /admin/settings` là chỗ đổi `maintenance_mode`, `read_only_mode` và
> `registration_enabled`. Bật `read_only_mode` **trước khi sao lưu** database:
> `pg_dump` chạy trong lúc có người đang ghi sẽ cho ra bản sao không nhất quán.

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
| GET | `/api/v1/follows/:userId` | Tuỳ chọn |
| GET | `/api/v1/follows/:userId/followers` | Tuỳ chọn |
| GET | `/api/v1/follows/:userId/following` | Tuỳ chọn |
| GET | `/api/v1/users/:id` | Tuỳ chọn |
| GET | `/api/v1/leaderboards` | Tuỳ chọn |
| GET | `/api/v1/feed/trending` | Tuỳ chọn |
| GET | `/api/v1/feed/for-you` | Đăng nhập |
| GET | `/api/v1/bookmarks` | Đăng nhập |
| GET | `/api/v1/bookmarks/folders` | Đăng nhập |
| GET | `/api/v1/bookmarks/:target/:id` | Tuỳ chọn |
| PUT | `/api/v1/bookmarks/:target/:id` | Đăng nhập |
| GET | `/api/v1/notifications` | Đăng nhập |
| GET | `/api/v1/notifications/unread-count` | Đăng nhập |
| POST | `/api/v1/notifications/read-all` | Đăng nhập |
| POST | `/api/v1/notifications/:id/read` | Đăng nhập |
| POST | `/api/v1/notifications/reconcile` | Đăng nhập |

`target` là một trong `document`, `post`, `collection`. Like và bookmark dùng
`PUT { "liked": true }` / `{ "bookmarked": true }` — nêu rõ trạng thái mong muốn
thay vì đảo trạng thái, để một request được thử lại không tự huỷ chính nó.

`GET /posts` có **hai chế độ phân trang**, chọn bằng việc có gửi `page` hay không:

| Gửi | Chế độ | `meta` |
|---|---|---|
| `page=2` | theo số trang | `total`, `totalPages`, `page` |
| không gửi `page` | theo con trỏ | `nextCursor`, `limit` |

Chế độ con trỏ dùng keyset trên `(created_at, id)`, phục vụ trực tiếp bởi chỉ mục
`posts_recent_idx`. Đây là chế độ của bảng tin: với phân trang theo số trang, một
bài được đăng trong lúc người đọc đang ở trang 1 sẽ đẩy mọi dòng xuống, nên trang 2
mở đầu bằng đúng bài cuối của trang 1 — người đọc thấy lặp, và bài bị đẩy qua ranh
giới thì không bao giờ thấy. Con trỏ không đếm, nên chế độ này **không** trả `total`;
nó lấy thêm một dòng để biết còn nữa hay không.

`nextCursor` là chuỗi **đục** (base64url) — client không nên tự dựng. Cursor sai
định dạng trả **400**, không âm thầm quay về trang 1: một cursor hỏng mà lặng lẽ bắt
đầu lại trông y hệt một lần tải lại trang.

Sắp xếp `popular` **bỏ qua** cursor và luôn dùng `page`: `hot_score` đổi theo mỗi
lượt thích, nên vị trí trong thứ tự đó không ổn định — con trỏ ở đó sẽ bỏ sót dòng
đi lên và lặp dòng đi xuống.

Trường `folder` của bookmark có **ba giá trị**, và ba giá trị này khác nhau:

| Gửi | Nghĩa |
|---|---|
| bỏ hẳn trường `folder` | giữ nguyên thư mục hiện tại |
| `"folder": null` | bỏ khỏi thư mục |
| `"folder": "Ôn thi"` | chuyển vào thư mục đó |

Gộp `null` và "không gửi" làm một (ví dụ bằng `.nullish()`) khiến một thư mục đã
đặt **không thể xoá được nữa** — hai yêu cầu trái ngược nhau trở thành cùng một
request. Nút Lưu trên trang chi tiết không gửi trường này, nên nó không bao giờ
vô tình bỏ nội dung ra khỏi thư mục.

`GET /bookmarks/folders` đếm bằng **cùng vị từ hiển thị** như danh sách, nên một
thư mục không bao giờ báo nhiều mục hơn số lượng mở ra thấy.

`GET /users/:id` trả về hồ sơ công khai. Trường `stats` ở đó là **số lượng mà
người gọi được xem**, không phải tổng của tài khoản — hồ sơ dẫn tới danh sách bài
đăng và tài liệu, và cả hai danh sách đó áp cùng vị từ, nên con số hiển thị luôn
khớp với danh sách mở ra. Tài khoản đã xoá dữ liệu (`anonymized_at`) trả **404**,
không trả một hồ sơ rỗng.

`reputation` và `badges` trong hồ sơ thì **không** lọc theo người xem — uy tín không
phải nội dung, nên không có gì để giữ lại. `reputation` có thể **âm**: khi nội dung
bị gỡ, một sự kiện trừ điểm lớn hơn phần đã cộng được ghi vào `reputation_events`,
và đó là nguồn sự thật duy nhất — mọi con số khác đều suy ra từ nó.

Điểm uy tín chỉ đến từ hành động của **người khác**. Tự thích nội dung của mình
không tính (chặn ở tầng ghi và bằng một CHECK constraint), mỗi nội dung chỉ tính
một lần dù thích/bỏ thích bao nhiêu lần (khoá `dedupe_key`), và có hai mức trần
trong 24 giờ: một người tặng tối đa **20 điểm** cho một người nhận, một người nhận
tối đa **100 điểm**. Huy hiệu được trao **lười** ngay khi ghi sự kiện uy tín — không
cần cron — và không bao giờ cộng ngược lại vào uy tín.

`GET /leaderboards` trả bảng xếp hạng theo tháng. `period` là khoá tháng dạng
`YYYY-MM` (mặc định là tháng hiện tại), `scope` là `university` | `faculty` |
`program`. Bảng toàn trường **không** nhận `scopeId` (dòng của nó lưu với
`scope_id IS NULL`); hai bảng còn lại **bắt buộc** có. Bảng chỉ gồm người có điểm
**dương** trong kỳ, và trường `viewer` cho biết vị trí của người gọi ngay cả khi họ
nằm ngoài trang trả về — hoặc `null` nếu họ chưa có điểm, vì xếp hạng một người
chưa đóng góp gì là con số vô nghĩa.

Hiện chỉ có kỳ `monthly`. `period_key` là text tự do nên học kỳ/năm thêm được
không cần migration, nhưng phải có tổng luỹ tiến riêng cho từng kỳ — và chưa có gì
duy trì chúng. Bảng toàn thời gian cũng vậy: nó là `sum(delta)` trên toàn bộ sự
kiện, đúng cái truy vấn mà bảng tổng luỹ tiến sinh ra để tránh.

`GET /feed/trending` xếp hạng theo tương tác trong **24 giờ gần nhất**, có suy giảm
theo tuổi, lưu trong Redis sorted set (một `ZINCRBY` cho mỗi lượt thích/bình
luận/bookmark, đọc bằng `ZUNIONSTORE` 24 bucket với trọng số `1, 1/2, 1/3…`). **Redis
chỉ là bộ tăng tốc**: hỏng Redis thì endpoint lùi về một truy vấn SQL có chặn (7 ngày,
`ORDER BY hot_score`), không trả lỗi. Trường `meta.ranking` cho biết bảng nào thực sự
đã chạy — `trending` hay `popular-fallback` — vì đó là hai khẳng định khác nhau và
client không nên phải đoán.

Tự thích bài của mình **không** ghi tín hiệu xu hướng (bài vẫn có lượt thích thật, chỉ
là vô nghĩa như một tín hiệu xếp hạng) — cùng lý do hệ thống uy tín từ chối tự thưởng.

`GET /feed/for-you` **yêu cầu đăng nhập**, và trả 401 nếu không có. Đây là **heuristic
minh bạch**, không phải học máy: điểm số là ba hạng tử đọc được — `+3` người bạn theo
dõi, `+2` cùng khoa với bạn, `+1` đang nổi bật — rồi lấy tương tác và độ mới làm
tiêu chí phụ. Tài khoản mới chưa theo dõi ai và chưa có khoa sẽ nhận bảng tin theo độ
mới (mọi hạng tử bằng 0), đó là suy giảm đúng chứ không phải lỗi. `meta.note` nói rõ
điều này trong chính phản hồi.

`GET /notifications/unread-count` trả **304** khi số chưa đọc không đổi, kèm`ETag` là chính con số đó — nhờ vậy một tab đang mở không tải lại dữ liệu mỗi phút.
Số này đọc từ cột đếm sẵn trên `users`, không phải `count(*)`. `POST
/notifications/reconcile` tính lại từ bảng gốc và dùng để tự sửa nếu cột bị lệch.

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

---

Tổng cộng **124 endpoint**.

Con số này là **toàn bộ** endpoint máy chủ đăng ký, không phải một phần: không
tính `HEAD`/`OPTIONS` mà Fastify tự thêm, và gộp những đường dẫn chỉ khác nhau ở
dấu `/` cuối (ví dụ `/api/v1/posts` và `/api/v1/posts/`).

---

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


