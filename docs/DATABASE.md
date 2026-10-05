# Cơ sở dữ liệu — TAILIEU TTN

PostgreSQL 16. **29 bảng** ở giai đoạn hiện tại, được định nghĩa bằng Drizzle trong
`backend/src/db/schema/`.

Tài liệu này giải thích **các quyết định thiết kế** — những thứ không đọc ra được
từ định nghĩa bảng, và những chỗ mà một thay đổi tưởng như vô hại sẽ gây hỏng dữ
liệu hoặc rò rỉ thông tin.

---

## 1. Thứ tự migration — quan trọng

```
npm run db:migrate
    │
    ├─ 1. pre.sql      Extension + immutable_unaccent()
    │                  PHẢI chạy trước: các chỉ mục GIN/trigram sinh ra
    │                  ở bước sau phụ thuộc vào chúng.
    │
    ├─ 2. drizzle/*    Migration sinh tự động, chỉ chạy tiến.
    │
    └─ 3. post.sql     Trigger, hàm tìm kiếm, ràng buộc CHECK.
                       PHẢI chạy sau: mọi câu lệnh đều tham chiếu bảng
                       chỉ tồn tại sau bước 2.
```

Sau khi chạy xong, `migrate.ts` **kiểm tra lại** rằng 3 trigger tìm kiếm và 2 hàm
thực sự tồn tại, và **thoát với lỗi** nếu không. Lý do: một trigger thiếu sẽ khiến
tìm kiếm trả về rỗng cho mọi tài liệu mới, một cách âm thầm — không có lỗi nào
hiện ra, chỉ là không tìm thấy gì.

> **Không dùng `drizzle-kit push`** ngoài thử nghiệm cục bộ. `push` so sánh và có
> thể **xoá cột**. Trên database chứa tài liệu thật, đó là mất dữ liệu.

---

## 2. Ba quyết định chịu lực

### 2.1 Xoá mềm + chỉ mục duy nhất MỘT PHẦN

Mọi khoá tự nhiên hướng người dùng đều dùng chỉ mục duy nhất **một phần**:

```sql
CREATE UNIQUE INDEX faculties_code_uq ON faculties (code)
  WHERE deleted_at IS NULL;
```

**Vì sao không dùng `UNIQUE (code)` thường:** chỉ mục duy nhất thường sẽ "đốt"
giá trị vĩnh viễn sau khi xoá mềm. Xoá nhầm một khoa rồi tạo lại với cùng mã sẽ
thất bại với lỗi trùng khoá, và không có cách nào sửa ngoài việc xoá cứng hàng cũ.
Điều này áp dụng cho: `faculties.code`, `programs.code`, `subjects.code`,
`documents.slug`, `users.username`, `tags.slug`, `academic_years.code`,
`document_types.code`.

**Ngoại lệ quan trọng — `users.email` dùng chỉ mục duy nhất KHÔNG điều kiện:**

```sql
CREATE UNIQUE INDEX users_email_uq ON users (email);
```

Người dùng **không bao giờ được xoá mềm để giải phóng email**. Nếu giải phóng, kẻ
tấn công có thể đăng ký lại địa chỉ của một sinh viên đã rời trường và **thừa
hưởng quyền tác giả, danh tiếng và tài liệu** của người đó. Tài khoản bị vô hiệu
giữ nguyên email; nếu cần xoá theo yêu cầu, **ẩn danh** địa chỉ
(`deleted+<uuid>@invalid`) thay vì trả tự do cho nó.

### 2.2 `search_text` do trigger + `tsv` sinh tự động

Đây là phần tinh tế nhất của lược đồ, và cũng là phần dễ làm hỏng nhất.

```sql
-- Cột thường, do TRIGGER ghi
search_text  text NOT NULL DEFAULT ''

-- Cột sinh tự động, KHÔNG BAO GIỜ ghi trực tiếp
tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', immutable_unaccent(search_text))
) STORED
```

**Vì sao phải tách hai cột:**

Một cột sinh tự động **không đọc được bảng khác**. Nhưng nội dung cần tìm kiếm
nằm rải rác: tên thẻ (`tags`), tên khoa (`faculties`), tên học phần (`subjects`),
mã ngành (`programs`). Không có cách nào để một cột sinh tự động gộp chúng lại.

Nên: **trigger** tính `search_text` từ tất cả các bảng đó, và cột sinh tự động
`tsv` tự cập nhật mỗi khi `search_text` đổi.

**Vì sao dùng cấu hình `simple`, không phải `english`:**

PostgreSQL **không có bộ tách từ tiếng Việt**. `to_tsvector('english', 'Công nghệ
thông tin')` áp quy tắc tiếng Anh lên tiếng Việt và tạo ra token rác. `simple` chỉ
tách theo khoảng trắng và dấu câu, không stemming — đúng hành vi mong muốn ở đây.

**Vì sao `immutable_unaccent`:**

`unaccent()` được đánh dấu `STABLE`, không phải `IMMUTABLE`, vì từ điển của nó là
đối tượng có thể sửa. PostgreSQL từ chối dùng hàm `STABLE` trong cột sinh tự động
hoặc chỉ mục biểu thức. Hàm bao `immutable_unaccent()` ghim từ điển theo tên và
khẳng định tính bất biến — an toàn vì từ điển `unaccent` không bao giờ bị sửa lúc chạy.

Không có nó, tìm kiếm "cong nghe" **không bao giờ** khớp "Công nghệ".

**Các trigger đang hoạt động:**

| Trigger | Kích hoạt khi |
|---|---|
| `documents_search_text_trg` | INSERT, hoặc UPDATE các cột tiêu đề/mô tả/taxonomy |
| `document_tags_search_text_trg` | Thêm/xoá/sửa thẻ của tài liệu |
| `tags_search_text_trg` | Đổi tên một thẻ |
| `faculties/programs/subjects/courses/document_types_search_text_trg` | Đổi tên một mục taxonomy |

> Trigger trên `documents` là `AFTER`, không phải `BEFORE`. Trigger `BEFORE INSERT`
> sẽ truy vấn một hàng chưa được ghi và tính ra haystack rỗng. Danh sách cột cũng
> **cố ý không bao gồm `search_text`** — đó là điều ngăn UPDATE bên trong trigger
> kích hoạt lại chính nó và đệ quy vô hạn.

### 2.3 Khoá ngoại `RESTRICT` cho taxonomy

```sql
faculty_id uuid NOT NULL REFERENCES faculties(id) ON DELETE RESTRICT
```

**Không bao giờ `CASCADE`** cho `documents.faculty_id`. Xoá một khoa mà cascade sẽ
**xoá luôn mọi tài liệu thuộc khoa đó** — phá huỷ hồ sơ học thuật. Cơ sở dữ liệu
từ chối trước cả khi logic ứng dụng chạy; đó là hành vi đúng.

Khoa có tài liệu thì **không xoá được**, chỉ **tạm ẩn** (`is_active = false`).
`is_active` mới là công tắc thật; `deleted_at` dành cho trường hợp xoá hẳn.

**Vì sao thay đổi taxonomy không phá dữ liệu lịch sử:** tài liệu tham chiếu khoa
bằng **UUID**, không bằng mã. Đổi tên khoa, đổi mã ngành, chuyển ngành sang khoa
khác — tài liệu vẫn trỏ đúng. Tính ổn định đến từ UUID, không từ mã.

---

## 3. Chiến lược chỉ mục

### Chỉ mục một phần phải khớp CHÍNH XÁC vị từ truy vấn

PostgreSQL chỉ dùng chỉ mục một phần khi nó **chứng minh được** vị từ truy vấn
suy ra vị từ của chỉ mục. Một khác biệt nhỏ — viết `status IN ('published')` thay
vì `status = 'published'` — biến truy vấn có chỉ mục thành **quét tuần tự toàn bảng**.

Để chống lại điều này, vị từ được chia sẻ như một hằng số duy nhất:

```ts
// backend/src/db/schema/predicates.ts
export const publishedDocument: SQL =
  sql`deleted_at IS NULL AND status = 'published' AND visibility <> 'private'`;
```

Dùng cùng một đối tượng trong **cả** định nghĩa chỉ mục **và** truy vấn. Lớp lỗi
này trở nên bất khả thi.

```sql
CREATE INDEX documents_faculty_idx ON documents (faculty_id, published_at DESC)
  WHERE deleted_at IS NULL AND status = 'published' AND visibility <> 'private';
```

### Các chỉ mục tìm kiếm

```sql
-- Toàn văn: khớp cả từ, có xếp hạng
CREATE INDEX documents_tsv_gin_idx ON documents USING gin (tsv);

-- Trigram: khớp một phần từ và chịu lỗi gõ
CREATE INDEX documents_title_trgm_idx ON documents
  USING gin (immutable_unaccent(title) gin_trgm_ops);
```

**Cả hai đều cần thiết.** `tsv` chỉ khớp **token hoàn chỉnh** — gõ "nghe" không ra
gì. Chỉ mục trigram mới cứu được các truy vấn một phần từ, vốn là cách sinh viên
thực sự gõ khi đang tìm.

Vị từ khớp trong mã nguồn dùng **cả hai**, nối bằng `OR`:

```sql
tsv @@ plainto_tsquery('simple', immutable_unaccent($1))
OR immutable_unaccent(search_text) ILIKE immutable_unaccent($2)
```

> **Cả hai vế đều phải bỏ dấu.** Chỉ bỏ dấu ở mẫu tìm kiếm là một lỗi hoàn toàn
> im lặng: `search_text` lưu văn bản **có dấu** ("Công nghệ"), nên `'%cong nghe%'`
> không khớp gì cả và **mọi truy vấn không dấu đều trả về rỗng** — mà gõ tiếng Việt
> không dấu là cách phần lớn người dùng tìm kiếm. Không có lỗi nào hiện ra.

### Bốn thứ tự sắp xếp, bốn chỉ mục

| Sắp xếp | Chỉ mục |
|---|---|
| Mới nhất | `documents_newest_idx (published_at DESC)` |
| Tải nhiều | `documents_popular_idx (download_count DESC)` |
| Đánh giá cao | `documents_rated_idx (rating_avg DESC NULLS LAST, rating_count DESC)` |
| Liên quan | Dùng `documents_tsv_gin_idx` + `ts_rank_cd` |

**Giới hạn đã biết:** không thể phủ mọi tổ hợp (bộ lọc × sắp xếp) bằng chỉ mục —
đó là bài toán tổ hợp. Hợp đồng thực tế: GIN phụ trách vị từ văn bản, các chỉ mục
một phần phụ trách bộ lọc phổ biến, và bốn chỉ mục trên phụ trách trường hợp
"không lọc thêm". Khi vượt qua giới hạn đó, **đó chính là tín hiệu để chuyển
`SearchProvider` sang Meilisearch**.

---

## 4. Ràng buộc CHECK — quy tắc nghiệp vụ ở tầng dữ liệu

Đặt trong `post.sql`, để chúng đúng ngay cả khi một nhánh mã tương lai, một phiên
`psql` thủ công, hoặc một script khôi phục quên mất quy tắc.

| Ràng buộc | Ngăn chặn |
|---|---|
| `document_ratings_rating_range_chk` | Điểm đánh giá ngoài 1–5 |
| `documents_counters_nonneg_chk` | Bộ đếm âm |
| `documents_rating_sum_chk` | `rating_sum` không khớp `rating_count` — bắt được UPDATE cập nhật một bộ đếm mà quên bộ kia |
| `documents_published_has_timestamp_chk` | Trạng thái `published` mà không có `published_at` |
| `storage_objects_size_chk` | Kích thước hoặc `ref_count` âm |
| `documents_slug_format_chk` | Slug không an toàn cho URL — một tiêu đề được tạo khéo có thể sinh liên kết phá định tuyến |
| `upload_sessions_shape_chk` | Phiên tải lên có hình dạng vô lý |

---

## 5. Đếm tham chiếu lưu trữ (`ref_count`)

Nhiều tài liệu có thể dùng chung **một đối tượng vật lý** — cùng một mẫu báo cáo
trăm sinh viên tải lên phải được lưu một lần.

```
storage_objects (content_hash PK, object_key, ref_count)
        ▲
        │ FK theo content_hash
document_files (document_id, content_hash, is_primary …)
```

**Quy tắc bắt buộc:** tăng `ref_count` và chèn `document_files` phải nằm trong
**cùng một transaction**. Nếu hai việc có thể lệch nhau, một tài liệu có thể tham
chiếu đối tượng mà bộ đếm bằng 0, và tiến trình dọn rác sẽ **xoá byte vẫn đang
được dùng** — mất dữ liệu âm thầm, chỉ lộ ra khi có người bấm tải và nhận 404.

Chỉ xoá đối tượng vật lý khi `ref_count` về **0**.

---

## 6. Bản đồ quan hệ

```
faculties ──1:N──▶ programs ──┐
    │                         │
    │                    program_subjects ──N:M──▶ subjects
    │                                               │
    │                                          courses (lớp học phần)
    │                                               │
    └────────────────┬──────────────────────────────┘
                     ▼
                 documents ──1:N──▶ document_files ──N:1──▶ storage_objects
                     │
                     ├──N:M──▶ tags              (qua document_tags)
                     ├──1:N──▶ document_ratings
                     ├──1:N──▶ download_events
                     └──1:N──▶ document_moderation_events

users ──1:N──▶ auth_identities    (mật khẩu ở đây, KHÔNG ở users)
      ──1:N──▶ sessions ──1:N──▶ refresh_tokens
      ──N:M──▶ roles             (qua user_roles, có thể giới hạn theo khoa)
      ──1:N──▶ upload_sessions ──1:N──▶ upload_chunks
      ──1:1──▶ storage_usage
```

### `courses` so với `subjects` — hai thứ khác nhau

- **`subjects`** — học phần trong danh mục toàn trường ("Lập trình C++")
- **`courses`** — một **lớp học phần** cụ thể trong một học kỳ ("C2026")

Đây là cách phân biệt chuẩn của Việt Nam. `documents.course_id` trỏ tới lớp;
`documents.subject_id` trỏ tới học phần. Một tài liệu có thể có cả hai, hoặc chỉ
một trong hai.

### `auth_identities` — vì sao mật khẩu không nằm ở `users`

Một người dùng có thể có danh tính mật khẩu, danh tính Google, hoặc cả hai.
Thêm nhà cung cấp OAuth sau này chỉ là một `INSERT`, không phải migration lược đồ.
`users` giữ thông tin hồ sơ; `auth_identities` giữ thông tin xác thực.

---

## 7. Truy vấn thường gặp và chỉ mục tương ứng

| Truy vấn | Chỉ mục được dùng |
|---|---|
| Danh sách tài liệu theo khoa, mới nhất trước | `documents_faculty_idx` |
| Tìm kiếm toàn văn có xếp hạng | `documents_tsv_gin_idx` |
| Tìm một phần từ | `documents_title_trgm_idx` |
| Tài liệu của tôi | `documents_owner_idx` |
| Hàng đợi kiểm duyệt | `documents_moderation_queue_idx` |
| Tài liệu đã đăng, tải nhiều nhất | `documents_popular_idx` |
| Phiên đang hoạt động của người dùng | `sessions_active_idx` |
| Tra token làm mới | `refresh_tokens_hash_uq` |
| Tra tài liệu theo phiên tải lên | `upload_sessions_user_idx` |

### Kiểm tra một truy vấn có dùng chỉ mục không

```bash
docker exec -it tailieu-postgres psql -U tailieu -d tailieu

EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM documents
 WHERE tsv @@ plainto_tsquery('simple', immutable_unaccent('cong nghe'))
   AND deleted_at IS NULL AND status = 'published' AND visibility <> 'private';
```

Phải thấy `Bitmap Index Scan on documents_tsv_gin_idx`. Nếu thấy `Seq Scan`, vị từ
truy vấn **không khớp** vị từ chỉ mục — kiểm tra lại `predicates.ts`.

---

## 8. Những việc thường làm

### Thêm một bảng

```bash
# 1. Tạo file trong backend/src/db/schema/
# 2. Export từ schema/index.ts  ← QUÊN BƯỚC NÀY thì bảng không được tạo
# 3. npm run db:generate       # sinh SQL, ĐỌC LẠI nó
# 4. npm run db:migrate
```

> Quên export ở `schema/index.ts` sẽ khiến `drizzle-kit` không thấy bảng — và với
> một bảng đã tồn tại, migration sinh ra sẽ **xoá nó**.

### Thêm một quyền

Sửa `backend/src/config/permissions.ts`, thêm vào vai trò liên quan, rồi:

```bash
npm run db:seed    # đồng bộ quyền vào database
```

Không cần migration. **Mã nguồn là nguồn sự thật**; seed chỉ phản chiếu.

### Kiểm tra tính toàn vẹn

```sql
-- Đối tượng lưu trữ không còn ai tham chiếu (rác)
SELECT content_hash, object_key, size_bytes FROM storage_objects WHERE ref_count = 0;

-- Tài liệu trỏ tới khoa đã bị xoá mềm
SELECT d.id, d.title FROM documents d
  JOIN faculties f ON f.id = d.faculty_id
 WHERE f.deleted_at IS NOT NULL AND d.deleted_at IS NULL;

-- Phiên tải lên bỏ dở (rò rỉ multipart trên storage)
SELECT id, staging_key, created_at FROM upload_sessions
 WHERE status IN ('pending','assembling') AND expires_at < now() - interval '1 day';

-- Phân bố điểm đánh giá bất thường
SELECT id, title, rating_count, rating_sum FROM documents
 WHERE rating_count > 0 AND rating_sum NOT BETWEEN rating_count AND rating_count * 5;
```

---

## 9. Những điều CHƯA có

| Thiếu | Hệ quả |
|---|---|
| **Phân vùng `audit_logs`** | Bảng này chỉ tăng. Ở quy mô hiện tại chưa thành vấn đề, nhưng `bigserial` khiến việc chuyển sang phân vùng về sau khó hơn — quyết định trước khi chạm ~10 triệu hàng. |
| **Phân vùng `download_events`** | Cùng lý do. |
| **Tiến trình dọn rác tự động** | Các truy vấn ở mục 8 hiện phải chạy tay. Cần một cron job. |
| **Sao lưu tự động** | Đã có hướng dẫn trong `DEPLOYMENT.md`, chưa cấu hình. |
| **Đa tenant** | `tenant_id` đã có chỗ trên các bảng taxonomy, luôn `NULL`, **không bao giờ** được tham chiếu trong mã. Thêm trường thứ hai là migration + chỉ mục một phần, không phải viết lại. |
