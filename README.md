# TAILIEU TTN

Nền tảng chia sẻ tài liệu học tập và cộng đồng học thuật cho **Đại học Tây Nguyên**.

Kho tri thức số: tài liệu, đề thi, bài giảng, giáo trình — được tổ chức theo khoa,
ngành, học phần và học kỳ, kèm tìm kiếm tiếng Việt, xem trước tài liệu, và kiểm duyệt.

---

## Nội dung

- [Kiến trúc trong một khung nhìn](#kiến-trúc-trong-một-khung-nhìn)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)
- [Các lệnh thường dùng](#các-lệnh-thường-dùng)
- [Triển khai](#triển-khai)
- [Tài liệu chi tiết](#tài-liệu-chi-tiết)
- [Những điều cần biết trước khi vận hành](#những-điều-cần-biết-trước-khi-vận-hành)

---

## Kiến trúc trong một khung nhìn

```
Người dùng
    │
    ▼
Cloudflare
    ├── tailieu.5125121.com/       ──▶  Cloudflare Pages  (React SPA)
    └── tailieu.5125121.com/api/*  ──▶  Pages Function ──▶ Cloudflare Tunnel
                                                                   │
                                                        (laptop / máy chủ)
                                                                   │
                                                          API (Fastify)
                                                       ┌───────────┼───────────┐
                                                       ▼           ▼           ▼
                                                  PostgreSQL     Redis     SeaweedFS
                                                                              (S3)
                                                                   │
                                                          Converter (LibreOffice)
```

**Điểm quan trọng:** frontend và API **cùng một origin** trong production. Một
Pages Function chuyển tiếp `/api/*` tới backend qua Cloudflare Tunnel. Nhờ vậy
không cần CORS, cookie là first-party, và **không có địa chỉ IP nào được công
khai** — máy chủ có thể đổi IP mà không ảnh hưởng gì.

---

## Bắt đầu nhanh

**Yêu cầu:** Node ≥ 20, Docker + Docker Compose.

```bash
git clone https://github.com/hoangtuvungcao/tailieu-web.git
cd tailieu-web

# 1. Tạo file môi trường và sinh khoá bí mật
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
#    → dán giá trị vào JWT_SECRET, JWT_REFRESH_SECRET, CSRF_SECRET, ARGON2_PEPPER
#    → mỗi khoá PHẢI khác nhau; hệ thống từ chối khởi động nếu trùng

# 2. Cài dependencies
npm install

# 3. Khởi động hạ tầng (Postgres, Redis, SeaweedFS, converter)
docker compose up -d

# 4. Tạo bảng và dữ liệu mẫu
npm run db:migrate
npm run db:seed

# 5. Chạy API và frontend (hai terminal riêng)
npm run dev:backend     # http://localhost:4000
npm run dev:frontend    # http://localhost:5173
```

Mở <http://localhost:5173>.

### Tài khoản mẫu

`db:seed` tạo ba tài khoản. Mật khẩu nằm trong `.env` (`SEED_*_PASSWORD`).

| Email | Vai trò |
|---|---|
| `admin@tailieu.local` | Quản trị tối cao |
| `moderator@tailieu.local` | Kiểm duyệt viên (toàn hệ thống) |
| `student@tailieu.local` | Sinh viên |

> Mật khẩu mặc định **phải được đổi** trước khi triển khai công khai.

---

## Cấu trúc thư mục

```
tailieu-web/
├── backend/                    API (Fastify + TypeScript)
│   ├── src/
│   │   ├── config/             Cấu hình môi trường, danh mục quyền
│   │   ├── db/
│   │   │   ├── schema/         Định nghĩa bảng (Drizzle)
│   │   │   ├── sql/            pre.sql + post.sql (trigger, ràng buộc)
│   │   │   ├── migrations/     SQL sinh tự động — đọc được, sửa tay được
│   │   │   └── seeds/          Dữ liệu mẫu (7 khoa, 37 ngành)
│   │   ├── lib/                Thư viện dùng chung (storage, search, preview…)
│   │   ├── modules/            Tính năng, mỗi module một thư mục
│   │   │   └── <tên>/
│   │   │       ├── *.route.ts       Khai báo endpoint
│   │   │       ├── *.controller.ts  HTTP ↔ DTO
│   │   │       ├── *.service.ts     Nghiệp vụ
│   │   │       ├── *.repository.ts  Truy vấn SQL
│   │   │       └── *.schema.ts      Kiểm tra đầu vào (Zod)
│   │   ├── plugins/            Plugin Fastify (envelope, auth, …)
│   │   └── workers/            Tiến trình nền (chuyển đổi Office)
│   └── Dockerfile, Dockerfile.worker
│
├── frontend/                   Web client (React + Vite)
│   ├── src/
│   │   ├── components/         Thành phần dùng chung
│   │   ├── lib/                API client, hooks, tiện ích
│   │   └── pages/              Trang
│   ├── functions/api/          Pages Function — proxy tới tunnel
│   └── public/_routes.json     Chỉ định route nào gọi Function
│
├── deploy/                     systemd unit, cấu hình cloudflared
└── docker-compose.yml          Hạ tầng phát triển
```

---

## Các lệnh thường dùng

| Lệnh | Tác dụng |
|---|---|
| `npm run infra:up` / `infra:down` | Bật/tắt hạ tầng Docker |
| `npm run dev:backend` | API với tự động nạp lại |
| `npm run dev:frontend` | Frontend với HMR |
| `npm run db:migrate` | Áp dụng migration |
| `npm run db:seed` | Nạp dữ liệu mẫu (chạy lại được, không trùng) |
| `npm run db:generate` | Sinh migration từ thay đổi schema |
| `npm test` | Chạy toàn bộ test (backend + frontend) |
| `npm run test:backend` | 164 test backend |
| `npm run test:frontend` | 50 test frontend |
| `npm run test:proxy --workspace frontend` | Kiểm tra Pages Function |
| `npm run test:setup --workspace backend` | Tạo database kiểm thử (mọi nền tảng) |
| `powershell -File scripts\e2e.ps1` | Kiểm thử đầu-cuối trên Windows |
| `npm run build` | Build cả hai phía |

### Cơ sở dữ liệu kiểm thử

Test chạy trên database **riêng biệt**, và từ chối chạy nếu tên database không
chứa `tailieu_test` — để một lần gõ nhầm `DATABASE_URL` không xoá dữ liệu thật.

```bash
npm run test:setup --workspace backend   # tạo + migrate + seed (mọi nền tảng)
npm test
```

> Lệnh npm dùng script Node, không dùng cú pháp bash — nên chạy được cả trên
> `cmd` và PowerShell. Trước đây chúng là `NODE_ENV=test ... vitest`, thứ mà
> Windows phân tích thành lệnh `NODE_ENV` và báo *"'NODE_ENV' is not recognized"*.

---

## Triển khai

Hướng dẫn đầy đủ: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**

> **Máy chủ Windows Server 2012 R2?** Đọc **[docs/WINDOWS.md](docs/WINDOWS.md)**
> trước. Docker **không chạy được** trên 2012 R2 (container Windows cần Server
> 2016 trở lên), nên ngăn xếp phải chạy như Windows service native — và Node 20
> nằm ngoài hỗ trợ trên hệ điều hành đó. Tài liệu giải thích cả hai rủi ro và
> cách xử lý.

Tóm tắt:

1. **Backend** chạy trên laptop/máy chủ, qua systemd (`deploy/systemd/`).
2. **Cloudflare Tunnel** công bố API tại một hostname **nội bộ**
   (`api-internal.tailieu.5125121.com`) — không bao giờ dùng IP tĩnh.
3. **Cloudflare Pages** phục vụ frontend tại `tailieu.5125121.com`, kèm một
   Function chuyển tiếp `/api/*` tới tunnel.

Biến môi trường bắt buộc cho Pages: `API_ORIGIN` (hostname tunnel).

> **Chưa bao giờ** trỏ `API_ORIGIN` về chính `tailieu.5125121.com` — Worker sẽ
> gọi lại chính nó thành vòng lặp vô tận.

---

## Tài liệu chi tiết

| Tài liệu | Nội dung | Trạng thái |
|---|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Quyết định thiết kế, đánh đổi, vì sao | ✅ |
| [DATABASE.md](docs/DATABASE.md) | Lược đồ, chỉ mục, trigger, soft delete | ✅ |
| [API.md](docs/API.md) | Toàn bộ 124 endpoint, quy ước chung | ✅ |
| [SECURITY.md](docs/SECURITY.md) | Mô hình bảo mật và các quyết định | ✅ |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Triển khai, sao lưu, xử lý sự cố | ✅ |
| [CONTRIBUTING.md](docs/CONTRIBUTING.md) | Quy ước mã nguồn, test, commit | ✅ |
| [WINDOWS.md](docs/WINDOWS.md) | Triển khai trên Windows Server 2012 R2 (không Docker) | ✅ |
| [ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) | Vận hành hằng ngày, phân quyền, xử lý sự cố | ✅ |
| [USER_GUIDE.md](docs/USER_GUIDE.md) | Dành cho sinh viên và giảng viên | ✅ |
| [ENVIRONMENT.md](docs/ENVIRONMENT.md) | Biến môi trường: cái nào quan trọng, sai thì hỏng gì | ✅ |
| [SQLSERVER_MIGRATION.md](docs/SQLSERVER_MIGRATION.md) | Hồ sơ quyết định: vì sao **ở lại PostgreSQL** thay vì SQL Server 2017 | ✅ |

> **`.env.example` là danh sách đầy đủ**; `ENVIRONMENT.md` bổ sung phần nó không
> nói: biến nào sai sẽ hỏng **lặng lẽ**, khác gì giữa dev và production, và vì sao
> bốn khoá bí mật phải khác nhau.

**Gợi ý đọc trước:** nếu bạn chỉ đọc một tài liệu, hãy đọc
[ARCHITECTURE.md](docs/ARCHITECTURE.md) §1 — ba ràng buộc của đề bài và cách mỗi
ràng buộc ép ra một quyết định kiến trúc cụ thể.

---

## Những điều cần biết trước khi vận hành

Đây là những giới hạn thật của hệ thống hiện tại, không phải danh sách tính năng
sẽ làm. Đọc trước khi công khai.

### Bảo mật

- **Quét virus mặc định TẮT, nhưng đã có sẵn.** ClamAV nằm sau một profile của
  Compose (`docker compose --profile scan up -d clamav`) vì cơ sở dữ liệu chữ ký
  chiếm ~1GB RAM — một khoản thật trên laptop. Bật bằng `SCAN_ENABLED=true`.

  Nguyên tắc chi phối: **tệp chưa có kết luận thì không tải được.**
  `document_files.status` giữ `pending` cho tới khi có phán quyết, và
  `getDownloadUrl` vốn đã từ chối mọi thứ không phải `ready` — nên cổng chặn có
  sẵn mà không phải sửa đường tải xuống. Bốn cách hỏng, cả bốn đều nghiêng về
  phía không phục vụ:

  - Phát hiện mã độc → `failed`, không bao giờ được phục vụ, báo người tải lên.
  - clamd không phản hồi → thử lại rồi vào dead-letter; tệp vẫn `pending`.
  - Tệp lớn hơn `SCAN_MAX_BYTES` → `skipped` và **không** phục vụ. "Không kiểm
    tra được" không giống "an toàn".
  - Quét đang tắt → `skipped` và vẫn phục vụ, vì người vận hành đã chọn vậy một
    cách rõ ràng; để mọi tệp tải lên kẹt ở `pending` mãi mãi là tự gây sự cố.

  Nếu `SCAN_ENABLED=true` mà clamd không trả lời, worker **từ chối khởi động**:
  nhận job quét mà không có bộ quét là cùng một sự cố, chỉ chậm hơn.
- **Chưa có Google OAuth.** Đã thiết kế xong (`auth_identities`), chưa bật vì
  chưa có thông tin xác thực.
- **Email mặc định chỉ ghi ra console.** Đặt `MAIL_DRIVER=smtp` trước khi công
  khai, nếu không người dùng sẽ không nhận được email xác minh hay đặt lại mật
  khẩu. `env.ts` từ chối khởi động với `console` trong production vì lý do này.

### Giới hạn đã biết

- **Tìm kiếm dừng ở mức cơ bản.** PostgreSQL không có bộ tách từ tiếng Việt, nên
  xếp hạng dùng `ts_rank_cd` trên vector `simple` đã bỏ dấu. Khớp cả từ và một
  phần từ (trigram), nhưng không có sửa lỗi gõ hay đồng nghĩa. Đây chính là lý do
  có interface `SearchProvider` — đổi sang Meilisearch chỉ cần thêm một lớp và
  một nhánh `case`.
- ~~Chưa có tính năng xã hội.~~ **Đã có** — bài đăng, bình luận, thích, theo dõi,
  bộ sưu tập, bookmark, thông báo, uy tín, huy hiệu, bảng xếp hạng và feed.
  Riêng tab **"Dành cho bạn"** là **heuristic minh bạch, không phải học máy**: nó
  trộn nội dung đang theo dõi, đăng ký khoa/ngành/học phần và nội dung nổi bật,
  rồi cộng điểm ái lực. Không có embedder hay ranker nào ở đây, và gọi nó là cá
  nhân hoá sẽ đặt ra kỳ vọng mà ngăn xếp này không đáp ứng được.
- ~~Chưa có trang quản trị.~~ **Đã có** — dashboard, người dùng, danh mục, hàng
  đợi kiểm duyệt, báo cáo, nhật ký kiểm toán, lưu trữ và cài đặt. Xem
  [ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md).
- ~~Frontend chưa có test.~~ **Đã có** — 50 test, nhưng vẫn chỉ phủ API client,
  các hàm tiện ích và hai trang. Phần lớn component và trang chưa có test.

### Vận hành

- **Máy chủ là một chiếc laptop.** Mất điện hoặc hỏng ổ đĩa là mất dịch vụ. Sao
  lưu định kỳ là việc bắt buộc, không phải tuỳ chọn — xem
  [DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **`ARGON2_PEPPER` mất là mất hết mật khẩu.** Giá trị này không nằm trong hash,
  nên phải sao lưu **tách riêng** khỏi sao lưu database.
- **AWS SDK cảnh báo cần Node ≥ 22** sau tháng 1/2027. Hiện chạy Node 20 ổn định,
  nhưng cần lên kế hoạch nâng cấp.

---

## Giấy phép

Dự án phục vụ mục đích học thuật cho Đại học Tây Nguyên.
Logo và tên trường thuộc Đại học Tây Nguyên; biểu trưng của nền tảng này là biểu
trưng phụ, không thay thế hay bắt chước logo chính thức.
