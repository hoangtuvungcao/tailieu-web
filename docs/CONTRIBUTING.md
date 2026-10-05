# Đóng góp — TAILIEU TTN

---

## Trước khi bắt đầu

```bash
npm install
cp .env.example .env      # sinh 4 khoá bí mật KHÁC NHAU
docker compose up -d
npm run db:migrate && npm run db:seed
```

Chạy kiểm tra trước khi mở pull request:

```bash
npm run typecheck          # cả hai phía
npm test                   # 47 test backend
npm run test:proxy --workspace frontend
npm run build
```

> **Test chạy trên database riêng.** `assertTestDatabase()` từ chối chạy nếu
> `DATABASE_URL` không chứa `tailieu_test`. Đây là chốt an toàn: bộ test **xoá
> người dùng và thu hồi phiên**, nên trỏ nhầm vào production là một sự cố.
>
> ```bash
> npm run test:db:setup --workspace backend
> ```

---

## Quy ước mã nguồn

### Bố cục module

Mỗi module theo đúng một khuôn. **SQL chỉ trong repository. HTTP chỉ trong controller.**

```
modules/<tên>/
  ├── <tên>.route.ts        Khai báo endpoint + gắn preHandler phân quyền
  ├── <tên>.controller.ts   HTTP ↔ DTO. KHÔNG SQL.
  ├── <tên>.service.ts      Nghiệp vụ, phân quyền, transaction
  ├── <tên>.repository.ts   Toàn bộ SQL. KHÔNG HTTP.
  └── <tên>.schema.ts       Zod
```

Module mới phải được đăng ký trong `src/routes/index.ts`.

### Chú thích: giải thích **vì sao**, không phải **cái gì**

Mã nguồn này được chú thích dày, nhưng **có chủ đích**. Quy ước:

> Nếu mã đã tự nói lên "cái gì", đừng viết lại. Nếu có một lựa chọn **trông như
> sai nhưng lại đúng**, hoặc **trông như đúng nhưng lại sai** — viết ra **vì sao**.

Ví dụ tốt, lấy từ mã thật:

```ts
// AFTER, not BEFORE: the row must be visible to the SELECT inside
// compute_document_search_text. A BEFORE trigger on INSERT would query for a
// row that has not been written yet and compute an empty haystack.
```

```ts
// `inArray`, not `= ANY($1::uuid[])`. A JavaScript array does not serialise to
// a valid Postgres array literal through a bound parameter — a single-element
// array arrives as the bare value and Postgres rejects it with
// `malformed array literal`.
```

Cả hai đều ghi lại một **cái bẫy đã thực sự gặp**, không phải giải thích cú pháp.

### Những chỗ KHÔNG được sửa mà không hiểu

| Chỗ | Vì sao |
|---|---|
| `visibilityPredicate` trong `documents.repository.ts` | Là ranh giới bảo mật. Phải nằm trong `WHERE`, không được lọc sau truy vấn. |
| `documents.mapper.ts` | Xây DTO từ danh sách trường tường minh. Trả hàng thô sẽ rò rỉ `object_key` và `bucket`. |
| Danh sách trắng trong `lib/files/mime.ts` | `text/html` và `image/svg+xml` vắng mặt **có chủ ý**. Thêm vào cần giải quyết vấn đề phục vụ an toàn trước. |
| `pre.sql` / `post.sql` | Thứ tự chạy quan trọng. `immutable_unaccent` phải có trước chỉ mục trigram. |
| `env.ts` — kiểm tra lúc khởi động | Từ chối khởi động production với bí mật mặc định hoặc `MAIL_DRIVER=console` là **có chủ ý**. |
| Secret trong `auth.service.ts` — transaction riêng | Phản ứng với dùng lại token phải **commit** trước khi báo lỗi. Xem `SECURITY.md` §1. |

### TypeScript

- `strict` bật. Không dùng `any` — dùng `unknown` rồi thu hẹp.
- Không `@ts-ignore`. Nếu buộc phải dùng, kèm `@ts-expect-error` **và** lý do.
- Import ESM phải có đuôi `.js` (chạy trên Node với `module: NodeNext`).

### Cơ sở dữ liệu

Thêm bảng:

```bash
# 1. Tạo file trong src/db/schema/
# 2. Export từ src/db/schema/index.ts   ← QUÊN = BẢNG KHÔNG ĐƯỢC TẠO
# 3. npm run db:generate                ← ĐỌC LẠI SQL sinh ra
# 4. npm run db:migrate
```

> Quên bước 2 khiến `drizzle-kit` không thấy bảng. Với bảng **đã tồn tại**,
> migration sinh ra sẽ **xoá nó**.

Thêm quyền: sửa `src/config/permissions.ts` rồi `npm run db:seed`. Không cần migration.

**Không dùng `drizzle-kit push`** ngoài thử nghiệm cục bộ — nó so sánh lược đồ và
có thể xoá cột.

### Giao diện

- Tiếng Việt cho mọi văn bản hướng người dùng.
- Dùng token thiết kế trong `styles.css`, không hard-code màu.
- **Không dùng `dangerouslySetInnerHTML`.** Kết quả tìm kiếm trả về văn bản có
  đánh dấu bằng ký tự điều khiển — render từng đoạn thành text node. Một tiêu đề
  `<script>alert(1)</script>` là đầu vào hợp lệ.
- Mọi phần tử tương tác phải dùng được bằng bàn phím và có nhãn cho trình đọc màn hình.

---

## Test

Test là **tích hợp**, chạy trên PostgreSQL và Redis thật, qua `app.inject()`.

**Vì sao không mock:** những lỗi thật sự nguy hiểm trong mã nguồn này nằm ở **đường
nối** — một transaction rollback mất việc thu hồi vừa ghi, một timestamp trả về
dạng chuỗi từ SQL thô, một mảng JavaScript không serialize thành array literal.
Test với repository được mock sẽ **pass hết** những lỗi đó.

Đã có tiền lệ: bộ test phân quyền theo khoa phát hiện `malformed array literal` ngay
lần chạy đầu — một lỗi mà mọi test mock đều bỏ qua.

### Khi thêm test

- **Fixture tự tạo, đừng dựa vào dữ liệu còn sót.** Một test phụ thuộc thứ tự chạy
  là test sẽ hỏng trong CI.
- **Đặt tên theo hành vi**, không theo hàm: `'detects reuse and revokes the whole
  family'`, không phải `'test refreshToken()'`.
- **Một khẳng định cho mỗi hành vi**, và khẳng định cả **trạng thái sau** khi có
  thay đổi. Ví dụ: kiểm duyệt bị từ chối **và** trạng thái tài liệu không đổi.

---

## Commit

```
<phạm vi>: <mô tả ngắn, thể mệnh lệnh>

Vì sao thay đổi này, không phải cái gì. Phần "cái gì" nằm ở diff.
```

Phạm vi: `auth`, `documents`, `upload`, `search`, `taxonomy`, `db`, `ui`, `deploy`, `docs`.

Ví dụ:

```
documents: enforce faculty scoping with inArray

`= ANY($1::uuid[])` không serialize mảng một phần tử thành array literal
hợp lệ, nên phân quyền theo khoa hỏng ở đúng trường hợp chính của nó và trả
500. Dùng inArray ở cả hai vị từ.
```

### Không bao giờ commit

`.env`, `*.dump`, `*.sql.gz`, thư mục `backups/`. Kiểm tra `git status` trước khi commit.

---

## Câu hỏi thường gặp khi đóng góp

**Test báo `Refusing to run tests against "postgres://..."`**
Đặt `DATABASE_URL` trỏ tới database có tên chứa `tailieu_test`. Xem
`npm run test:db:setup`.

**Migration sinh ra lệnh `DROP TABLE`**
Bảng đó không được export từ `schema/index.ts`. Thêm export rồi sinh lại.

**Tìm kiếm trả về rỗng cho truy vấn không dấu**
Vị từ khớp phải bỏ dấu **cả hai vế**. Xem `docs/DATABASE.md` §2.2.

**Typecheck báo lỗi ở `vite.config.ts`**
Đã loại khỏi `tsconfig.json` — npm workspaces cài hai bản Vite với kiểu `Plugin`
khác nhau về danh nghĩa. Vite tự kiểm tra file cấu hình của nó.
