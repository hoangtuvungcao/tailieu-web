# Biến môi trường — TAILIEU TTN

**Danh sách đầy đủ và chính xác nằm ở [`.env.example`](../.env.example)** — nó có
chú thích cho từng nhóm, và vì nó là tệp bạn thực sự sao chép nên nó không thể lệch
khỏi thực tế. Tài liệu này bổ sung phần mà `.env.example` không nói: **biến nào
quan trọng, sai thì hỏng thế nào, và khác gì giữa dev và production.**

> `src/config/env.ts` kiểm tra toàn bộ môi trường **một lần lúc khởi động** và
> **từ chối chạy** nếu thiếu hoặc sai. Đây là chủ ý: hỏng lúc khởi động hiện ra
> ngay, hỏng lúc 3 giờ sáng thì không.

---

## 1. Bốn khoá bí mật

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Biến | Dùng cho |
|---|---|
| `JWT_SECRET` | Ký token truy cập |
| `JWT_REFRESH_SECRET` | Dự trữ cho token làm mới |
| `CSRF_SECRET` | Ký cookie CSRF |
| `ARGON2_PEPPER` | Trộn vào hash mật khẩu |

**Bốn giá trị phải KHÁC NHAU.** `env.ts` **từ chối khởi động** nếu phát hiện hai
giá trị trùng — dùng chung một khoá nghĩa là một lần rò rỉ phá cả ba lớp bảo vệ.

### `ARGON2_PEPPER` — biến nguy hiểm nhất

Nó **không nằm trong hash**. `argon2.verify` cần cả hash trong database **và**
pepper này.

> **Mất `ARGON2_PEPPER` là mất toàn bộ mật khẩu**, kể cả khi database còn nguyên.
> Không có cách khôi phục. Mọi người dùng phải đặt lại mật khẩu.
>
> **Sao lưu nó ở nơi KHÁC với bản sao lưu database**, và mã hoá. Để chung một chỗ
> nghĩa là một lần mất là mất cả hai.

---

## 2. Biến mà sai sẽ hỏng lặng lẽ

Những biến này không gây lỗi rõ ràng — chúng gây ra hành vi sai mà không ai nhận ra.

### `VITE_API_URL`

```
✅ /api/v1              đường dẫn tương đối
❌ https://tailieu.5125121.com/api/v1
```

Frontend và API **cùng một origin**. Dùng URL tuyệt đối biến mọi request thành
cross-origin, và cookie phiên sẽ không được gửi — người dùng đăng nhập rồi bị đăng
xuất sau mỗi lần tải lại trang.

### `API_ORIGIN` (biến của Cloudflare Pages, không phải của API)

```
✅ https://api-internal.tailieu.5125121.com   hostname tunnel
❌ https://tailieu.5125121.com                chính nó
```

Trỏ về tên miền công khai khiến Worker **gọi lại chính mình** cho tới khi
Cloudflare cắt ở giới hạn subrequest.

### `S3_FORCE_PATH_STYLE`

| Backend | Giá trị |
|---|---|
| SeaweedFS, MinIO | `true` |
| Cloudflare R2, AWS S3 | `false` |

Sai giá trị cho ra `SignatureDoesNotMatch` — một lỗi không nói gì về nguyên nhân.

### `TRUST_PROXY`

`false` mặc định. Đặt `true` **chỉ khi** API nằm sau Cloudflare Tunnel.

- `false` sau tunnel → giới hạn tần suất khoá theo địa chỉ của tunnel, mọi người
  dùng chung một hạn mức.
- `true` khi **không** có proxy → ai cũng giả được IP và vượt giới hạn.

### `MAIL_DRIVER`

`env.ts` **từ chối khởi động** với `console` trong production. Đây là chủ ý: email
đặt lại mật khẩu in ra log và không bao giờ được gửi nghĩa là người dùng không thể
khôi phục tài khoản — **và không có lỗi nào hiện ra** để ai đó nhận ra.

---

## 3. Giới hạn của Cloudflare

Hai biến bị ràng buộc bởi hạ tầng, không phải bởi sở thích.

### `UPLOAD_CHUNK_SIZE_BYTES`

**Phải dưới 100MB.** Cloudflare từ chối mọi request body lớn hơn, và mọi phần tải
lên đều đi qua Pages Function.

`env.ts` **từ chối khởi động** nếu giá trị này vượt ngưỡng — nếu không, nó chỉ hỏng
sau khi triển khai, khi người dùng thật đang tải tệp thật.

Mặc định 8MB. Tăng lên làm giảm số request nhưng tăng nguy cơ timeout trên đường
truyền chậm.

### `MAX_UPLOAD_SIZE_BYTES`

Tổng kích thước tệp cho phép (khác với kích thước một phần). Mặc định 2GB.

---

## 4. Khác biệt dev và production

| Biến | Dev | Production | Vì sao |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | Bật kiểm tra an toàn lúc khởi động, tắt log debug |
| `LOG_LEVEL` | `debug` | `info` | `debug` ghi mọi câu SQL |
| `DATABASE_SSL` | `false` | `true` (nếu DB từ xa) | |
| `CORS_ORIGINS` | `localhost:5173` | **đúng một** origin | `env.ts` từ chối `localhost` trong production |
| `COOKIE_DOMAIN` | trống | trống | Chỉ đặt nếu API ở subdomain khác |
| `MAIL_DRIVER` | `console` | `smtp` | |
| `SCAN_ENABLED` | `false` | `true` (nên) | |
| `SEED_*_PASSWORD` | có | **xoá khỏi file** | Không để mật khẩu mẫu trong production |

`env.ts` kiểm tra và **từ chối** trong production nếu: `API_PUBLIC_URL` không phải
HTTPS, `CORS_ORIGINS` chứa `localhost`, `MAIL_DRIVER=console`, thiếu
`ARGON2_PEPPER`, hoặc phát hiện giá trị mẫu như `change_me`.

---

## 5. Nơi đặt biến

| Môi trường | Ở đâu |
|---|---|
| Phát triển | `.env` ở gốc repo (**không commit**) |
| API production (Linux) | `/etc/tailieu/api.env`, `chmod 600`, đọc bởi systemd |
| API production (Windows) | `C:\tailieu\.env`, đọc bởi chính API qua dotenv |
| Worker | Cùng tệp với API |
| Frontend | Cloudflare Pages → Settings → Environment variables |
| cloudflared | `/etc/cloudflared/config.yml`, không phải biến môi trường |

`env.ts` tìm `.env` theo thứ tự: `backend/.env` trước, rồi `.env` ở gốc. Biến đã
có trong môi trường tiến trình **luôn thắng** — nên `EnvironmentFile` của systemd
đè lên mọi `.env` còn sót trên máy.

---

## 6. Kiểm tra cấu hình

```bash
cd backend
node -e "import('./dist/config/env.js').then(m => console.log('OK'))"
```

Hoặc chỉ cần khởi động API — nó in ra **mọi** vấn đề cùng lúc rồi thoát, thay vì
báo từng cái một:

```
Invalid environment configuration:
  - JWT_SECRET and JWT_REFRESH_SECRET are identical. Each secret must be unique.
  - CORS_ORIGINS must not contain localhost in production.
```

Và kiểm tra nhanh public API:

```bash
curl -s https://tailieu.5125121.com/api/health
```

---

## 7. Biến chưa dùng nhưng đã có chỗ

Đã khai báo để thêm sau không cần sửa cấu trúc:

| Biến | Trạng thái |
|---|---|
| `GOOGLE_CLIENT_ID` / `_SECRET` | Đã thiết kế (`auth_identities`), chưa bật |
| `SMTP_*` | Chỉ dùng khi `MAIL_DRIVER=smtp` |
| `AI_PROVIDER` / `AI_API_KEY` / `AI_BASE_URL` | Chưa có tính năng AI nào |
| `SENTRY_DSN` | Khai báo, chưa nối |
