# Triển khai: Windows Server 2012 R2 + Cloudflare Pages

Hướng dẫn này đi từ một máy chủ trống tới một website đang chạy, theo đúng thứ
tự bạn sẽ làm. Nó gộp hai nửa của hệ thống vào một chỗ:

| Nửa | Chạy ở đâu |
|---|---|
| **Backend** (API, worker, database, kho tệp) | Windows Server 2012 R2 tại trường |
| **Frontend** (giao diện, proxy `/api/*`) | Cloudflare Pages |

Hai tài liệu đi sâu hơn, dùng khi cần chứ không cần đọc trước:

- **[WINDOWS.md](WINDOWS.md)** — vì sao mọi thứ trên Windows lại làm theo cách này,
  và những chỗ khác biệt so với bản Linux.
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — bản Linux, cùng kiến trúc, dùng khi chuyển
  sang máy chủ Linux.
- **[ENVIRONMENT.md](ENVIRONMENT.md)** — từng biến môi trường, sai thì hỏng thế nào.

> **Đọc trước khi bắt đầu.** Hai điều không thể tránh trên 2012 R2, và cả hai đều
> là rủi ro thật chứ không phải cảnh báo hình thức:
>
> **1.** Windows Server 2012 R2 **đã hết vòng đời từ 10/2023**, và Node.js 20
> **không được hỗ trợ chính thức** trên hệ điều hành này. Nó chạy, nhưng chạy
> ngoài hỗ trợ: không ai kiểm thử tổ hợp này, và một lỗi chỉ xuất hiện trên 2012 R2
> sẽ không được sửa. Nếu nâng được lên Windows Server 2019/2022 thì mọi thứ dễ hơn
> — Docker hoạt động và toàn bộ ngăn xếp chạy đúng như thiết kế.
>
> **2.** **Docker không dùng được.** Container Windows cần Server 2016 trở lên, và
> Docker Desktop không hỗ trợ bất kỳ bản Windows Server nào. Nghĩa là
> `docker-compose.yml` trong repo **không dùng được ở đây** — mỗi thành phần chạy
> như một Windows service riêng.

---

## Kiến trúc

```
                        Internet
                            │
                            ▼
                   Cloudflare  (DNS + TLS + CDN)
                            │
        ┌───────────────────┴────────────────────┐
        │                                        │
        ▼                                        ▼
tailieu.5125121.com                    api-internal.tailieu.5125121.com
Cloudflare Pages                       (hostname NỘI BỘ, không quảng bá)
  ├── React SPA (dist/)                        │
  └── Pages Function /api/*  ──────────────────┤
                                               ▼
                                    Cloudflare Tunnel (chiều RA)
                                               │
                            ┌──────────────────┘
                            │   ← máy chủ trường, KHÔNG mở cổng nào vào
                            ▼
                   127.0.0.1:3000
                   node.exe  (service: tailieu-api)
                            │
        ┌───────────┬───────┴────────┬──────────────┐
        ▼           ▼                ▼              ▼
   PostgreSQL   Memurai          SeaweedFS     LibreOffice
     :5432       :6379            :8333      (gọi khi cần)
   (14)        (thay Redis)

   node.exe (tailieu-worker)   → chuyển đổi Word/PowerPoint sang PDF
   node.exe (tailieu-cleanup)  → dọn dẹp định kỳ
```

Ba điều đáng chú ý trong sơ đồ này:

- **Tunnel kết nối đi ra, không có kết nối vào.** Không cổng nào của máy chủ được
  mở ra Internet. Đó là lý do không cần IP tĩnh và không phải mở 80/443.
- **Trình duyệt chỉ nói chuyện với `tailieu.5125121.com`.** Frontend và API cùng
  một origin, nên cookie phiên hoạt động và không có CORS giữa hai bên.
- **`api-internal...` là hostname nội bộ.** Nó tồn tại chỉ để Pages Function gọi
  vào. Đừng quảng bá nó, và đừng trỏ frontend vào nó.

**Thứ tự làm: backend trước, frontend sau.** Pages Function trỏ tới
`api-internal...`; nếu tunnel chưa chạy thì mọi request API từ trang web đều 502 và
bạn sẽ đi tìm lỗi ở nhầm chỗ.

---

# Phần A — Backend trên Windows Server 2012 R2

Tất cả lệnh PowerShell dưới đây chạy với quyền **Administrator**.

## A1. Phần mềm nền

Cài theo thứ tự. Mỗi mục có một lệnh kiểm tra — chạy nó trước khi sang mục sau.

| # | Phần mềm | Ghi chú |
|---|---|---|
| 1 | **PowerShell 5.1** | 2012 R2 có sẵn 4.0; script chạy được nhưng 5.1 có log tốt hơn |
| 2 | **Node.js 20** | Có thể phải bỏ kiểm tra nền tảng — xem ngay dưới |
| 3 | **NSSM** | Bọc ứng dụng console thành Windows service |
| 4 | **PostgreSQL 14** | Bản 15+ cần Server 2016 trở lên |
| 5 | **Memurai** | Redis không có bản Windows chính thức |
| 6 | **SeaweedFS** (`weed.exe`) | Kho tệp |
| 7 | **LibreOffice** | Chuyển đổi tài liệu Office sang PDF |
| 8 | **cloudflared** | Đường ra Internet |

### Node.js 20 — bộ cài có thể từ chối chạy

Đặt biến này **trước khi cài**, và đặt vĩnh viễn cho máy:

```powershell
[Environment]::SetEnvironmentVariable('NODE_SKIP_PLATFORM_CHECK', '1', 'Machine')
# Mở PowerShell MỚI rồi mới chạy bộ cài
node --version    # phải in ra v20.x
```

Đây là chạy ngoài hỗ trợ — xem cảnh báo ở đầu tài liệu.

### NSSM

Tải từ <https://nssm.cc/download>, giải nén `win64\nssm.exe` vào
`C:\tools\nssm\nssm.exe`.

```powershell
Test-Path C:\tools\nssm\nssm.exe    # → True
```

### PostgreSQL 14

Tải từ <https://www.postgresql.org/download/windows/>. Ghi lại mật khẩu `postgres`
đặt lúc cài. Sau đó tạo database và người dùng riêng:

```powershell
$env:PGPASSWORD = '<mật-khẩu-postgres>'
$psql = 'C:\Program Files\PostgreSQL\14\bin\psql.exe'

& $psql -U postgres -c "CREATE USER tailieu WITH PASSWORD '<mật-khẩu-mới>';"
& $psql -U postgres -c "CREATE DATABASE tailieu OWNER tailieu;"

Get-Service postgresql*     # phải thấy postgresql-x64-14 đang Running
```

> **`OWNER tailieu` là bắt buộc, không phải cho đẹp.** Migration chạy
> `CREATE EXTENSION` cho `pgcrypto`, `citext`, `unaccent` và `pg_trgm`. Bốn
> extension này là *trusted* từ PostgreSQL 13, nên **chủ sở hữu database** tạo được
> mà không cần quyền superuser — nhưng nếu bạn để database thuộc `postgres` rồi kết
> nối bằng `tailieu`, migration dừng ngay ở bước đầu với
> `permission denied to create extension "citext"`.

Bốn extension đó không cần tạo tay — `backend/src/db/sql/pre.sql` tạo chúng ở bước
đầu của `npm run db:migrate`, trước mọi migration sinh tự động, vì các chỉ mục GIN
và trigram ở sau cần chúng. Kiểm tra sau khi migrate xong:

```powershell
& $psql -U tailieu -d tailieu -c "\dx"
# → citext, pg_trgm, pgcrypto, unaccent — đủ cả bốn
```

### Memurai

Tải Memurai Developer từ <https://www.memurai.com/get-memurai>. Bộ cài tự đăng ký
service tên `Memurai`.

> **Mặc định của Memurai không an toàn.** Nó không đặt mật khẩu và lắng nghe trên
> mọi giao diện. Sửa `C:\Program Files\Memurai\memurai.conf`:
>
> ```
> bind 127.0.0.1
> requirepass <mật-khẩu-mạnh>
> ```
>
> rồi `Restart-Service Memurai`. Để nguyên mặc định nghĩa là bất kỳ ai vào được
> máy trong cùng mạng đều đọc và ghi được cache phiên cùng hàng đợi công việc.

### SeaweedFS

```powershell
# 1. Tải weed.exe cho Windows từ
#    https://github.com/seaweedfs/seaweedfs/releases
#    đặt vào C:\tailieu\bin\weed.exe

# 2. Thông tin đăng nhập S3
New-Item -ItemType Directory -Force C:\tailieu\seaweedfs | Out-Null
# Tạo C:\tailieu\seaweedfs\s3.json với nội dung:
@'
{
  "identities": [
    {
      "name": "tailieu",
      "credentials": [
        { "accessKey": "THAY_BANG_KHOA_CUA_BAN", "secretKey": "THAY_BANG_KHOA_CUA_BAN" }
      ],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
'@ | Set-Content C:\tailieu\seaweedfs\s3.json -Encoding UTF8

# 3. Service
& C:\tools\nssm\nssm.exe install tailieu-storage C:\tailieu\bin\weed.exe
& C:\tools\nssm\nssm.exe set tailieu-storage AppParameters "server -dir=C:\tailieu\seaweedfs\data -s3 -s3.port=8333 -s3.config=C:\tailieu\seaweedfs\s3.json -master.volumeSizeLimitMB=1024 -volume.max=200 -master.garbageThreshold=1.0"
& C:\tools\nssm\nssm.exe set tailieu-storage AppStdout C:\tailieu\logs\seaweedfs.log
& C:\tools\nssm\nssm.exe set tailieu-storage AppStderr C:\tailieu\logs\seaweedfs.error.log
Start-Service tailieu-storage
```

> **Lưu ý quan trọng trên Windows:**
> - Đường dẫn trong `-dir` phải **tuyệt đối**. SeaweedFS không phân giải `~` hay biến môi trường theo cách Windows mong đợi.
> - Cờ `-master.garbageThreshold=1.0` là **bắt buộc** để tránh lỗi Windows file locking khi SeaweedFS chạy auto-vacuum khiến volume bị xóa ngoài ý muốn.

### LibreOffice

Cài vào đường dẫn mặc định. Nếu cài chỗ khác, đặt `SOFFICE_PATH` trong `.env`.

```powershell
& "C:\Program Files\LibreOffice\program\soffice.exe" --version
```

### cloudflared

```powershell
# Tải cloudflared-windows-amd64.exe từ
#   https://github.com/cloudflare/cloudflared/releases
# đổi tên thành cloudflared.exe, đặt vào C:\tailieu\cloudflared\cloudflared.exe
# rồi thêm C:\tailieu\cloudflared vào PATH của máy:
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';C:\tailieu\cloudflared',
  'Machine')
# Mở PowerShell MỚI
cloudflared --version
```

> **Chưa cài nó như service.** Script ở bước A5 làm việc đó, và có lý do — xem
> phần tunnel ngay dưới.

## A2. Mã nguồn và cấu hình

```powershell
New-Item -ItemType Directory -Force C:\tailieu | Out-Null
cd C:\tailieu
git clone https://github.com/hoangtuvungcao/tailieu-web.git .
# hoặc giải nén từ tệp zip

Copy-Item .env.production.example .env
notepad .env
```

`.env` phải có **đúng** những giá trị này cho Windows. Những dòng không có trong
`.env.production.example` được đánh dấu ⬅.

```bash
NODE_ENV=production
API_PORT=3000
API_HOST=127.0.0.1                       # ⬅ loopback, xem giải thích bên dưới
API_PUBLIC_URL=https://tailieu.5125121.com
LOG_LEVEL=info
TRUST_PROXY=true                         # ⬅ API nằm sau tunnel

DATABASE_URL=postgres://tailieu:<mật-khẩu>@127.0.0.1:5432/tailieu
DATABASE_SSL=false                       # Postgres cùng máy, không có TLS
DATABASE_POOL_MAX=20

REDIS_URL=redis://:<mật-khẩu-memurai>@127.0.0.1:6379

S3_ENDPOINT=http://127.0.0.1:8333
S3_ACCESS_KEY=<khớp đúng s3.json>
S3_SECRET_KEY=<khớp đúng s3.json>
S3_BUCKET=tailieu-documents
S3_STAGING_BUCKET=tailieu-staging
S3_FORCE_PATH_STYLE=true                 # SeaweedFS: true. R2/S3: false
S3_REGION=us-east-1

# BỐN giá trị KHÁC NHAU. API từ chối khởi động nếu trùng nhau.
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=...
JWT_REFRESH_SECRET=...
CSRF_SECRET=...
ARGON2_PEPPER=...

CORS_ORIGINS=https://tailieu.5125121.com   # đúng MỘT origin, không localhost
COOKIE_DOMAIN=

MAIL_DRIVER=smtp
MAIL_FROM="TAILIEU TTN <no-reply@tailieu.5125121.com>"
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
SMTP_SECURE=false

UPLOAD_CHUNK_SIZE_BYTES=8388608          # phải dưới 100MB — Cloudflare cắt trên ngưỡng đó
MAX_UPLOAD_SIZE_BYTES=2147483648

# Tài khoản tạo bởi db:seed. BẮT BUỘC đổi trước khi seed trên máy chủ thật —
# giá trị mặc định nằm trong repo công khai nên seeder sẽ từ chối chúng.
SEED_ADMIN_EMAIL=admin@<tên-miền-của-bạn>
SEED_ADMIN_PASSWORD=<mật-khẩu-mạnh-riêng>
SEED_MODERATOR_EMAIL=moderator@<tên-miền-của-bạn>
SEED_MODERATOR_PASSWORD=<mật-khẩu-mạnh-riêng>
SEED_STUDENT_EMAIL=student@<tên-miền-của-bạn>
SEED_STUDENT_PASSWORD=<mật-khẩu-mạnh-riêng>

TUNNEL_HOSTNAME=api-internal.tailieu.5125121.com
CLOUDFLARE_PUBLIC_URL=https://tailieu.5125121.com
```

> **`API_HOST=127.0.0.1` — đây là yêu cầu bảo mật, không phải khẩu vị.** Tunnel
> chạy trên cùng máy nên nó kết nối được qua loopback. Đổi thành `0.0.0.0` là mở
> API cho cả mạng LAN, và khi đó bất kỳ máy nào trong mạng cũng **tự khai được địa
> chỉ IP của mình** — nghĩa là tự chọn hạn mức của mình. Xem phần
> [Kiểm chứng chuỗi địa chỉ](#c2-kiểm-chứng-chuỗi-địa-chỉ).

> **`ARGON2_PEPPER` là biến nguy hiểm nhất trong tệp này.** Nó không nằm trong
> hash mật khẩu. **Mất nó là mất toàn bộ mật khẩu**, kể cả khi database còn
> nguyên, và không có cách khôi phục. Sao lưu nó ở nơi **khác** với bản sao lưu
> database, và mã hoá.

Kiểm tra cấu hình trước khi đi tiếp — API in ra **mọi** vấn đề cùng lúc rồi thoát:

```powershell
cd C:\tailieu\backend
node -e "import('./dist/config/env.js').then(() => console.log('OK')).catch(e => { console.error(e.message); process.exit(1) })"
```

## A3. Cài đặt, build, khởi tạo dữ liệu

```powershell
cd C:\tailieu
npm install
npm run build --workspace backend

cd C:\tailieu\backend
npm run db:migrate
npm run db:seed
```

`db:seed` tạo taxonomy (khoa, ngành, học phần), cấu hình mặc định, huy hiệu và các
tài khoản mẫu.

> **Phải đặt `SEED_ADMIN_PASSWORD` (và hai biến còn lại) trước khi chạy `db:seed`
> trên máy chủ thật.** `.env.example` nằm trong một repository **công khai**, nên
> `ChangeMe_Admin_2026` không phải bí mật — nó là giá trị mặc định ai cũng đọc
> được. Seeder **từ chối chạy** trong production nếu mật khẩu vẫn là mặc định, và
> báo rõ cần đặt biến nào:
>
> ```
> Refusing to seed admin@tailieu.local with the published default password in production.
> ```
>
> Đây là chủ ý: nếu không chặn, `db:seed` sẽ tạo một tài khoản `super_admin` mà bất
> kỳ ai đã đọc repository đều đăng nhập được, và không có gì khác trong hệ thống
> phản đối — mật khẩu đủ dài, và tài khoản được đánh dấu đã xác minh nên vào được
> ngay.
>
> Chạy lại seeder trên hệ thống đã có dữ liệu vẫn bình thường — đó là cách cập nhật
> RBAC và taxonomy. Kiểm tra chỉ kích hoạt khi một mật khẩu mặc định **sắp trở
> thành** thông tin đăng nhập thật.

Sau khi đăng nhập lần đầu, đổi mật khẩu qua giao diện và xoá các biến `SEED_*`
khỏi `.env`.

## A4. Tunnel — chỗ dễ sai nhất trên Windows

Phần này không có trong `DEPLOYMENT.md` vì tài liệu đó viết cho Linux.

```powershell
# 1. Đăng nhập. Lệnh này in ra một URL thay vì mở trình duyệt trên máy chủ —
#    mở URL đó trên máy của bạn, chọn tên miền 5125121.com.
cloudflared tunnel login          # → C:\Users\<bạn>\.cloudflared\cert.pem

# 2. Tạo tunnel. Ghi lại UUID mà nó in ra.
cloudflared tunnel create tailieu-api

# 3. Tạo bản ghi DNS cho hostname NỘI BỘ.
cloudflared tunnel route dns tailieu-api api-internal.tailieu.5125121.com

# 4. Chép thông tin xác thực vào chỗ service sẽ đọc.
Copy-Item "$env:USERPROFILE\.cloudflared\<UUID>.json" C:\tailieu\cloudflared\
Copy-Item "C:\tailieu\deploy\cloudflared\config.yml" C:\tailieu\cloudflared\config.yml
notepad C:\tailieu\cloudflared\config.yml
```

Trong `config.yml`, sửa hai dòng đầu cho đúng đường dẫn Windows:

```yaml
tunnel: <UUID-thật>
credentials-file: C:\tailieu\cloudflared\<UUID-thật>.json
```

Phần `ingress` giữ nguyên — nó đã đúng, và đã trỏ tới `127.0.0.1:3000`:

```yaml
ingress:
  - hostname: api-internal.tailieu.5125121.com
    service: http://127.0.0.1:3000
    originRequest:
      connectTimeout: 30s
      httpHostHeader: 127.0.0.1:3000
  - service: http_status:404
```

Kiểm tra **trước khi** chạy thật — lệnh này bắt lỗi cú pháp và lỗi ingress mà
không cần khởi động gì:

```powershell
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://api-internal.tailieu.5125121.com/api/health
```

Lệnh thứ hai phải in ra rule khớp và service đích. Nếu nó rơi vào
`http_status:404`, hostname trong `config.yml` gõ sai.

> **Đừng dùng `cloudflared service install` ở đây.** Trên Windows, lệnh đó chạy
> service dưới tài khoản **LocalSystem**, và `USERPROFILE` của tài khoản đó là
> `C:\Windows\System32\config\systemprofile` — nên nó đi tìm `config.yml` ở một
> chỗ khác với nơi bạn vừa chép, **không báo lỗi**, rồi thất bại với một thông báo
> không liên quan ("bad handshake"). Cách sửa của Cloudflare là sửa registry
> `ImagePath`; ở đây không cần, vì `install-services.ps1` đã bọc cloudflared bằng
> NSSM với cờ `--config` chỉ thẳng đường dẫn. Đường dẫn tường minh thì không có gì
> để đoán sai.

## A5. Đăng ký service

```powershell
cd C:\tailieu\deploy\windows
.\install-services.ps1 -InstallRoot C:\tailieu -NssmPath C:\tools\nssm\nssm.exe
```

Script kiểm tra prerequisites trước và **dừng** nếu thiếu gì, liệt kê những thứ
cần cài. Nó đăng ký bốn service:

| Service | Chạy gì | Phụ thuộc |
|---|---|---|
| `tailieu-api` | `node dist/server.js` | PostgreSQL, Memurai |
| `tailieu-worker` | worker chuyển đổi Office → PDF | Memurai |
| `tailieu-cleanup` | dọn dẹp định kỳ | — |
| `tailieu-tunnel` | `cloudflared tunnel run` | `tailieu-api` |

Phụ thuộc được khai báo chứ không giả định: Windows khởi động service song song,
nên nếu không khai báo thì API và PostgreSQL đua nhau lúc boot.

Tunnel **chưa** chạy sau bước này — `tailieu-tunnel` cần `cloudflared` có trên
PATH, nên nếu bạn cài nó sau khi chạy script thì chạy lại script.

```powershell
Start-Service tailieu-api
Start-Service tailieu-worker
Start-Service tailieu-cleanup
Start-Service tailieu-tunnel

Get-Service tailieu-* | Format-Table Name, Status, StartType
```

Cả bốn phải `Running`, và `StartType` phải là `Automatic` để tự lên sau khi reboot.

## A6. Tường lửa

Máy chủ Windows mặc định mở nhiều thứ hơn máy chủ Linux. Làm tối thiểu những việc
sau:

```powershell
# Chặn toàn bộ lưu lượng vào theo mặc định
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultInboundAction Block

# RDP, nếu bạn cần quản trị từ xa. Cân nhắc đổi cổng.
New-NetFirewallRule -DisplayName 'RDP' -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Allow
```

> **Không mở 3000, 5432, 6379, 8333 — và không mở 80/443.** Tunnel kết nối **đi
> ra**, nên không cần một cổng vào nào. Đó là toàn bộ lợi ích của tunnel. Nếu ai đó
> bảo bạn mở 443 để Cloudflare vào được, người đó đang mô tả một kiến trúc khác.

---

# Phần B — Frontend trên Cloudflare Pages

## B1. Tạo dự án

Bảng điều khiển Cloudflare → **Workers & Pages** → **Create** → **Pages** →
**Connect to Git** → chọn repository `tailieu-web`.

| Trường | Giá trị |
|---|---|
| Framework preset | **None** (cấu hình thủ công) |
| Root directory | `frontend` |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |

> **Root directory phải là `frontend`.** Repo có cả backend; để trống nghĩa là
> Pages build nhầm nửa kia.

## B2. Biến môi trường

**Settings → Environment variables** — đặt cho **cả Production _và_ Preview**:

| Biến | Giá trị |
|---|---|
| `API_ORIGIN` | `https://api-internal.tailieu.5125121.com` |
| `VITE_API_URL` | `/api/v1` |

> **`API_ORIGIN` không bao giờ được là `https://tailieu.5125121.com`.** Pages
> Function chạy trên chính hostname đó; trỏ về nó là Worker **gọi lại chính mình**
> cho tới khi Cloudflare cắt ở giới hạn subrequest.

> **`VITE_API_URL` phải là đường dẫn tương đối `/api/v1`**, không phải URL đầy đủ.
> Frontend và API cùng một origin; dùng URL tuyệt đối biến mọi request thành
> cross-origin và **cookie phiên sẽ không được gửi** — người dùng đăng nhập rồi bị
> đăng xuất sau mỗi lần tải lại trang.

## B3. Tên miền

**Custom domains** → thêm `tailieu.5125121.com`. Cloudflare tự tạo bản ghi DNS.

## B4. Triển khai

```powershell
cd C:\tailieu
git push origin main
```

Pages tự build và triển khai. Theo dõi ở tab **Deployments**.

---

# Phần C — Kiểm chứng

## C1. Bốn lớp, theo thứ tự

Đừng bỏ qua lớp nào — mỗi lớp cô lập một đoạn khác nhau của đường đi, và khi có
lỗi thì biết ngay nó ở đoạn nào.

```powershell
# Lớp 1 — API sống, tại chỗ
Invoke-RestMethod http://127.0.0.1:3000/api/health
# → {"success":true,"data":{"status":"ok",...}}

# Lớp 2 — dữ liệu thật đã vào
$f = Invoke-RestMethod http://127.0.0.1:3000/api/v1/taxonomy/faculties
$f.data.Count                     # → 7

# Tìm kiếm tiếng Việt không dấu — chứng minh unaccent + pg_trgm hoạt động
(Invoke-RestMethod 'http://127.0.0.1:3000/api/v1/search/suggest?q=cong').data

# Lớp 3 — qua tunnel (hostname nội bộ)
Invoke-RestMethod https://api-internal.tailieu.5125121.com/api/health

# Lớp 4 — qua chính tên miền công khai. ĐÂY là cái người dùng thấy.
Invoke-RestMethod https://tailieu.5125121.com/api/health
```

Lỗi ở từng lớp nghĩa là gì:

| Hỏng ở lớp | Nguyên nhân |
|---|---|
| 1 | `.env` sai hoặc service chưa chạy — xem `C:\tailieu\logs\tailieu-api.error.log` |
| 2 | Migration chưa chạy, hoặc thiếu extension PostgreSQL |
| 3 | `tailieu-tunnel` chưa chạy, hoặc `config.yml` sai hostname |
| 4 | `API_ORIGIN` của Pages sai, hoặc custom domain chưa gắn |

## C2. Kiểm chứng chuỗi địa chỉ

Phần này kiểm tra thứ mà **không có thông báo lỗi nào** khi nó sai, nên nó phải
được kiểm tra chủ động.

Bối cảnh: request đi `trình duyệt → Pages → Pages Function → Tunnel → 127.0.0.1`.
Chặng cuối là loopback, nên nếu không có gì đọc header, API sẽ thấy **mọi người
dùng trên Internet đều là `127.0.0.1`**. Hệ quả: giới hạn 300 request/phút thành
hạn mức dùng chung của cả trường, và `sessions.ip` cùng `audit_logs.ip` ghi cùng
một địa chỉ — khiến "thu hồi thiết bị kia" và "việc này đến từ đâu" không trả lời
được.

Cách kiểm tra: đăng nhập qua **tên miền công khai**, rồi đọc địa chỉ mà API đã ghi
lại.

```powershell
# 1. Đăng nhập qua tên miền công khai (không phải localhost)
$body = @{ email = 'admin@tailieu.local'; password = '<mật-khẩu>' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri https://tailieu.5125121.com/api/v1/auth/login `
  -Body $body -ContentType 'application/json' -SessionVariable web

# 2. Đọc địa chỉ đã ghi cho phiên vừa tạo
$env:PGPASSWORD = '<mật-khẩu-tailieu>'
& 'C:\Program Files\PostgreSQL\14\bin\psql.exe' -U tailieu -d tailieu -c `
  "SELECT ip, user_agent, created_at FROM sessions ORDER BY created_at DESC LIMIT 3;"
```

**Kết quả đúng:** cột `ip` hiện **địa chỉ công khai của bạn** (hoặc địa chỉ IPv6
của nhà mạng), không phải `127.0.0.1` và không phải `::1`.

**Nếu thấy `127.0.0.1`:** chuỗi đang đứt. Kiểm tra theo thứ tự:

```powershell
# a. Pages Function có đang chạy không? (Cloudflare dashboard → Pages → Functions
#    → Real-time logs). Nó phải thấy request của bạn.

# b. Tunnel có chuyển tiếp header không?
cloudflared tunnel ingress rule https://api-internal.tailieu.5125121.com/api/health

# c. API có đọc header không? Địa chỉ đến từ X-Forwarded-For, và chỉ được tin
#    khi kết nối đến từ loopback — nên API_HOST phải là 127.0.0.1.
Select-String -Path C:\tailieu\.env -Pattern 'API_HOST'
```

Kiểm tra nhanh rằng API **từ chối** tin header từ nơi khác — chạy trên máy khác
trong cùng mạng, trỏ tới địa chỉ LAN của máy chủ:

```powershell
# Trên MÁY KHÁC. Phải bị TỪ CHỐI KẾT NỐI.
Invoke-RestMethod http://<địa-chỉ-LAN-của-máy-chủ>:3000/api/health
```

Kết nối bị từ chối nghĩa là `API_HOST` đúng. Nếu nó trả về JSON, API đang lắng
nghe trên LAN — sửa `.env` và khởi động lại `tailieu-api` **ngay**, vì lúc đó bất
kỳ ai trong mạng cũng tự khai được IP của mình.

## C3. Kiểm thử tự động

Bộ end-to-end đi qua **chính origin frontend**, nên nó kiểm tra luôn cả proxy chứ
không chỉ backend:

```powershell
# Terminal 1
cd C:\tailieu
npm run dev --workspace frontend

# Terminal 2
powershell -ExecutionPolicy Bypass -File C:\tailieu\scripts\e2e.ps1
```

Kết quả đúng: **120/120 kiểm tra đạt**.

> Chạy bộ này **trên máy chủ**, không phải từ máy bạn. Nó đăng ký tài khoản, tải
> tệp lên và xoá dữ liệu — chạy nhầm vào production đang có người dùng thật là
> không nên.

## C4. Danh sách kiểm tra thủ công

Những thứ máy không tự kiểm được. Làm hết một lượt sau khi triển khai:

- [ ] Mở `https://tailieu.5125121.com/` — giao diện hiện ra, **không** lệch ngang,
      không có thanh cuộn ngang ở chế độ điện thoại
- [ ] Mở DevTools → Console — **không** có lỗi đỏ, không có request 4xx/5xx
- [ ] Đăng ký một tài khoản mới qua giao diện
- [ ] Đăng nhập, **tải lại trang** — vẫn đăng nhập (cookie làm mới hoạt động)
- [ ] Tải lên một tệp PDF → xem trước được ngay trong trang
- [ ] Tải lên một tệp Word → chờ vài giây → xem trước được (worker chuyển đổi chạy)
- [ ] Tìm `cong nghe` (không dấu) → ra kết quả **có dấu** "Công nghệ thông tin"
- [ ] Mở một tài liệu ở chế độ ẩn danh → **không** thấy tài liệu `private`
- [ ] Đăng xuất → mở `/bookmarks` → bị đưa về trang đăng nhập
- [ ] Khởi động lại máy chủ → sau ~1 phút, cả bốn service `Running` và trang web
      hoạt động lại **mà không cần làm gì**

---

# Xử lý sự cố

Các lỗi đã gặp thật, và cách nhận ra chúng.

### Service khởi động rồi dừng ngay

```powershell
Get-Content C:\tailieu\logs\tailieu-api.error.log -Tail 40
```

API **từ chối khởi động** khi cấu hình sai thay vì chạy nửa vời, và nó in ra mọi
vấn đề cùng lúc. Đọc thông báo — nó nói rõ thiếu gì.

### `'NODE_ENV' is not recognized`

Script npm đang chạy bằng cú pháp bash. Chạy `npm install` lại để lấy `cross-env`.

### Xem trước tệp Word không bao giờ xong

```powershell
Get-Content C:\tailieu\logs\tailieu-worker.error.log -Tail 30
& "C:\Program Files\LibreOffice\program\soffice.exe" --version
```

Nếu `--version` báo không tìm thấy, đặt `SOFFICE_PATH` trong `.env`. Nếu chuyển đổi
treo, kiểm tra `C:\tailieu\tmp\` có ghi được không — LibreOffice cần thư mục tạm
ghi được, và tài khoản chạy service phải có quyền.

### Máy chủ chậm dần rồi hết dung lượng

Phiên tải lên bỏ dở đang rò rỉ phần multipart:

```powershell
cd C:\tailieu\backend
npm run cleanup
Get-Service tailieu-cleanup
```

### Không kết nối được từ Internet

```powershell
Get-Service tailieu-tunnel
Get-Content C:\tailieu\logs\tailieu-tunnel.error.log -Tail 30
```

Nguyên nhân thường gặp nhất là `config.yml` sai đường dẫn credentials, hoặc
`API_ORIGIN` của Pages trỏ tới `tailieu...` thay vì `api-internal...`.

### Trang web tải được nhưng mọi request API đều lỗi

Đây gần như luôn là tunnel hoặc Pages Function, **không phải** backend — backend
đã được kiểm ở lớp 1. Xem log Function: Cloudflare dashboard → Pages → dự án →
**Functions → Real-time logs**.

### Người dùng bị đăng xuất ngẫu nhiên, hoặc 429 khi tải lại trang

`/auth/refresh` được giới hạn theo **địa chỉ**, và mỗi lần tải lại trang đầy đủ gọi
nó một lần. Nghĩa là cả một dãy phòng máy hoặc một khoa cùng đi ra Internet qua
**một địa chỉ NAT** sẽ **dùng chung một hạn mức**.

```powershell
Select-String -Path C:\tailieu\.env -Pattern 'RATE_LIMIT_REFRESH'
```

Nâng `RATE_LIMIT_REFRESH_PER_15MIN` lên (ví dụ 600) rồi `Restart-Service tailieu-api`.
Đây là giới hạn tài nguyên chứ không phải lớp chống lạm dụng — lớp đó là việc xoay
token, vốn vẫn nguyên vẹn — nên nâng lên là an toàn.

Trước khi nâng, hãy chắc rằng `API_HOST=127.0.0.1` và chuỗi địa chỉ hoạt động
([C2](#c2-kiểm-chứng-chuỗi-địa-chỉ)). Nếu API đang thấy mọi người là `127.0.0.1` thì
hạn mức bị dùng chung cho **toàn bộ Internet**, và nâng số lên chỉ là chữa triệu
chứng.

### Tải lên thất bại ở tệp lớn

```powershell
Select-String -Path C:\tailieu\.env -Pattern 'UPLOAD_CHUNK_SIZE_BYTES'
```

Phải **dưới 100MB** (mặc định 8MB). Cloudflare từ chối mọi request body lớn hơn,
và mọi phần tải lên đều đi qua Pages Function.

### Không tìm thấy service `tailieu-api` (`Cannot find any service with service name 'tailieu-api'`)

Nếu `Get-Service *tailieu*` chỉ trả về mỗi `tailieu-storage`, nghĩa là bạn chưa đăng ký các service Node (API, Worker, Cleanup) vào Windows Services.

Chạy script tự động cài đặt:
```powershell
cd C:\tailieu\deploy\windows
.\install-services.ps1 -InstallRoot C:\tailieu -NssmPath C:\tools\nssm\nssm.exe

# Khởi động dịch vụ sau khi cài:
Start-Service tailieu-api, tailieu-worker, tailieu-cleanup
```

Nếu đang chạy API tạm thời bằng cửa sổ CMD / Terminal (`npm run dev` hoặc `node dist/server.js`), bạn chỉ cần tắt cửa sổ đó bằng `Ctrl + C`, `git pull origin main`, `npm run build` và khởi động lại.

### SeaweedFS báo lỗi `LookupFileId ... failed, err: urls not found` hoặc `The process cannot access the file because it is being used by another process`

**Nguyên nhân:** Trên Windows, khi SeaweedFS chạy cơ chế dọn rác tự động (auto-vacuum), nó cố ghi đè file `.dat` nhưng bị Windows lock file chặn lại. SeaweedFS tưởng volume bị hỏng nên tự động xóa volume khỏi cụm, làm mất dữ liệu của các file trong volume đó.

**Khắc phục:**
1. Cập nhật tham số NSSM của `tailieu-storage` để tắt auto-vacuum:
```powershell
& C:\tools\nssm\nssm.exe set tailieu-storage AppParameters "server -dir=C:\tailieu\seaweedfs\data -s3 -s3.port=8333 -s3.config=C:\tailieu\seaweedfs\s3.json -master.volumeSizeLimitMB=1024 -volume.max=200 -master.garbageThreshold=1.0"
Restart-Service tailieu-storage
```
2. Cập nhật backend lên phiên bản mới nhất (`git pull origin main && npm run build`). Backend đã có cơ chế tự chữa lành (Self-healing): khi người dùng upload lại tài liệu, nếu phát hiện file cũ trong storage bị mất ruột, backend sẽ giữ lại file mới và cập nhật bản ghi Database thay vì gán nhầm vào file hỏng cũ.

---

# Vận hành

## Cập nhật phiên bản mới

```powershell
cd C:\tailieu
git pull

npm install
npm run build --workspace backend
cd backend
npm run db:migrate          # chạy cả khi không chắc có migration mới

Restart-Service tailieu-api
Restart-Service tailieu-worker
Restart-Service tailieu-cleanup
```

Frontend tự triển khai khi `git push` lên `main`.

## Sao lưu

Ba thứ phải sao lưu, và **một thứ phải để ở chỗ khác**:

| Sao lưu gì | Ở đâu |
|---|---|
| Database | `C:\tailieu\backups\` — xem `deploy\windows\backup.ps1` |
| Tệp tài liệu | `C:\tailieu\seaweedfs\data\` |
| `.env` | Nơi mã hoá, **tách khỏi** hai thứ trên |

Đặt lịch bằng Task Scheduler:

```powershell
$action  = New-ScheduledTaskAction -Execute 'C:\tailieu\deploy\windows\backup.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName 'TAILIEU Backup' -Action $action -Trigger $trigger -RunLevel Highest
```

> **`ARGON2_PEPPER` trong `.env` để chung với bản sao lưu database nghĩa là một lần
> mất là mất cả hai.** Database sao lưu được khôi phục, nhưng mật khẩu trong đó chỉ
> dùng được khi có pepper — thiếu nó thì mọi người dùng phải đặt lại mật khẩu.

## Xem log

```powershell
Get-Content C:\tailieu\logs\tailieu-api.log -Tail 50 -Wait
```

Bốn tệp log trong `C:\tailieu\logs\`: `tailieu-api`, `tailieu-worker`,
`tailieu-cleanup`, `tailieu-tunnel` — mỗi cái có bản `.log` và `.error.log`.

---

## Tóm tắt những chỗ khác bản Linux

| | Linux (Docker) | Windows 2012 R2 |
|---|---|---|
| Cách ly LibreOffice | Container riêng | Chung máy, chỉ giới hạn bằng affinity |
| Redis | Redis 7 | Memurai (tương thích 7.2.6) |
| Quản lý tiến trình | systemd | NSSM + Windows Service |
| Node | Được hỗ trợ | **Ngoài hỗ trợ** |
| Hỗ trợ hệ điều hành | Đến 2027+ | **Hết vòng đời 10/2023** |
| Cập nhật | `docker compose pull` | `git pull` + build + `Restart-Service` |

Nếu có bất kỳ khả năng nào, hãy nâng lên **Windows Server 2019/2022** hoặc chuyển
sang **một máy Linux**. Cả hai đều loại bỏ rủi ro Node ngoài hỗ trợ, khôi phục lớp
cách ly container, và cho phép dùng đúng `docker-compose.yml` đã được kiểm chứng.

Ở lại 2012 R2 là được — nhưng bạn đang chạy một ngăn xếp Linux-native trên một hệ
điều hành đã hết vòng đời, với runtime ngoài hỗ trợ, và không có cách ly giữa
LibreOffice và API.
