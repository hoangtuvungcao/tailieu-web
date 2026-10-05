# Triển khai trên Windows Server 2012 R2

Hướng dẫn này dành cho trường hợp máy chủ chạy **Windows Server 2012 R2** và
không dùng Docker.

> **Vì sao không dùng Docker:** container Windows gốc cần **Windows Server 2016
> trở lên** — kernel của 2012 R2 thiếu primitive cách ly container. Docker Desktop
> cũng không hỗ trợ bất kỳ bản Windows Server nào. Giải pháp thay thế duy nhất
> (WinDocks) chỉ chạy được image .NET và SQL Server, không chạy Postgres, Redis,
> SeaweedFS hay LibreOffice.
>
> Nghĩa là toàn bộ `docker-compose.yml` **không dùng được** ở đây. Mỗi thành phần
> chạy như một Windows service native.

---

## Đọc trước: hai rủi ro thật

**1. Node.js 20 không được hỗ trợ chính thức trên hệ điều hành này.**
Windows Server 2012 R2 hết vòng đời tháng 10/2023, và chính sách của Node kết
thúc hỗ trợ cho hệ điều hành có ngày EOL của nhà cung cấp sớm hơn tháng 4/2025.
Node **vẫn chạy** trên thực tế, nhưng đây là chạy ngoài hỗ trợ: không ai kiểm thử
tổ hợp này cho các bản phát hành mới, và một lỗi chỉ trên 2012 R2 sẽ không được
sửa.

Nếu có thể, hãy **nâng cấp lên Windows Server 2019/2022** — khi đó Docker hoạt
động và toàn bộ ngăn xếp chạy đúng như thiết kế. Phần còn lại của tài liệu này
giả định bạn buộc phải ở lại 2012 R2.

**2. Mất lớp cách ly container.** Trong thiết kế Docker, LibreOffice chạy trong
container riêng để một tài liệu hỏng không kéo sập API. Ở đây nó chạy chung máy.
Hạn chế bằng cách giới hạn tài nguyên tiến trình worker (xem phần Bảo vệ).

---

## Kiến trúc trên Windows

```
Cloudflare
    │  tailieu.5125121.com        → Cloudflare Pages (frontend)
    │  tailieu.5125121.com/api/*  → Pages Function
    ▼
api-internal.tailieu.5125121.com
    │
cloudflared.exe  (service: tailieu-tunnel)
    │
localhost:4000
    │
node.exe  (service: tailieu-api)
    │
    ├── PostgreSQL  (service: postgresql-x64-14)
    ├── Memurai     (service: Memurai)          ← thay Redis
    ├── SeaweedFS   (service: tailieu-storage)  ← weed.exe
    └── LibreOffice (không phải service, gọi khi cần)

node.exe  (service: tailieu-worker)   → chuyển đổi Office
node.exe  (service: tailieu-cleanup)  → dọn dẹp định kỳ
```

---

## Chuẩn bị

### Bắt buộc: PowerShell 5.1

2012 R2 có sẵn PowerShell 4.0. Script cài đặt viết cho 4.0 nên vẫn chạy, nhưng
nên nâng lên 5.1 để có log và xử lý lỗi tốt hơn:

```powershell
# Tải Windows Management Framework 5.1 từ Microsoft, rồi:
# https://www.microsoft.com/en-us/download/details.aspx?id=54616
Get-Host | Select-Object Version
```

### Node.js

Node 20 for Windows. **Bộ cài có thể từ chối chạy trên 2012 R2** vì kiểm tra
phiên bản hệ điều hành. Nếu vậy:

```powershell
# Bỏ qua kiểm tra nền tảng — chạy NGOÀI HỖ TRỢ, xem cảnh báo ở trên
$env:NODE_SKIP_PLATFORM_CHECK = 1
```

Đặt biến này vĩnh viễn cho máy:

```powershell
[Environment]::SetEnvironmentVariable('NODE_SKIP_PLATFORM_CHECK', '1', 'Machine')
```

Kiểm tra: `node --version` phải in ra `v20.x`.

### NSSM

Node và cloudflared là ứng dụng console, không tự nhận mình là service. Cần một
lớp bọc:

1. Tải từ <https://nssm.cc/download>
2. Giải nén `win64\nssm.exe` vào `C:\tools\nssm\nssm.exe`

### PostgreSQL

PostgreSQL 14 là bản cuối còn hỗ trợ tốt trên 2012 R2 (bản 15+ yêu cầu Windows
Server 2016 trở lên).

1. Tải bộ cài Windows từ <https://www.postgresql.org/download/windows/>
2. Cài đặt, ghi nhớ mật khẩu `postgres`
3. Kiểm tra service `postgresql-x64-14` đang chạy

Tạo database và người dùng:

```powershell
$env:PGPASSWORD = '<mật khẩu postgres>'
& "C:\Program Files\PostgreSQL\14\bin\psql.exe" -U postgres -c "CREATE USER tailieu WITH PASSWORD '<mật khẩu mới>';"
& "C:\Program Files\PostgreSQL\14\bin\psql.exe" -U postgres -c "CREATE DATABASE tailieu OWNER tailieu;"
```

### Memurai (thay Redis)

**Redis không có bản Windows chính thức.** Memurai tương thích Redis 7.2.6 và hỗ
trợ Windows Server 2012 trở lên.

1. Tải Memurai Developer (miễn phí) từ <https://www.memurai.com/get-memurai>
2. Cài đặt — nó tự đăng ký service tên `Memurai`
3. Kiểm tra: `Get-Service Memurai`

> Memurai mặc định **không yêu cầu mật khẩu** và lắng nghe trên mọi giao diện.
> Phải sửa `C:\Program Files\Memurai\memurai.conf`:
> ```
> bind 127.0.0.1
> requirepass <mật-khẩu-mạnh>
> ```
> rồi `Restart-Service Memurai`. Để nguyên mặc định nghĩa là bất kỳ ai vào được
> máy trong cùng mạng đều đọc/ghi được cache phiên và hàng đợi công việc.

Sau đó `REDIS_URL` trong `.env` phải là:
```
REDIS_URL=redis://:<mật-khẩu-mạnh>@127.0.0.1:6379
```

### SeaweedFS

SeaweedFS là một binary Go, có bản Windows.

1. Tải `weed.exe` cho Windows từ <https://github.com/seaweedfs/seaweedfs/releases>
2. Đặt vào `C:\tailieu\bin\weed.exe`
3. Tạo `C:\tailieu\seaweedfs\s3.json`:

```json
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
```

4. Đăng ký service (chạy với quyền Administrator):

```powershell
& C:\tools\nssm\nssm.exe install tailieu-storage C:\tailieu\bin\weed.exe
& C:\tools\nssm\nssm.exe set tailieu-storage AppParameters "server -dir=C:\tailieu\seaweedfs\data -s3 -s3.port=8333 -s3.config=C:\tailieu\seaweedfs\s3.json"
& C:\tools\nssm\nssm.exe set tailieu-storage AppStdout C:\tailieu\logs\seaweedfs.log
& C:\tools\nssm\nssm.exe set tailieu-storage AppStderr C:\tailieu\logs\seaweedfs.error.log
Start-Service tailieu-storage
```

5. Kiểm tra: `Invoke-WebRequest http://localhost:8333 -UseBasicParsing`

> Đường dẫn trong `-dir` phải là **đường dẫn tuyệt đối** — SeaweedFS không phân
> giải `~` hay biến môi trường theo cách Windows mong đợi.

### LibreOffice

1. Tải từ <https://www.libreoffice.org/download/download/>
2. Cài vào đường dẫn mặc định `C:\Program Files\LibreOffice`
3. Kiểm tra: `& "C:\Program Files\LibreOffice\program\soffice.exe" --version`

> Nếu cài vào ổ khác, đặt `SOFFICE_PATH` trong `.env` trỏ tới `soffice.exe`.
> Worker tự tìm ở `C:\Program Files\LibreOffice\program\soffice.exe`.

### cloudflared

1. Tải `cloudflared-windows-amd64.exe` từ
   <https://github.com/cloudflare/cloudflared/releases>
2. Đổi tên thành `cloudflared.exe`, đặt vào `C:\tailieu\cloudflared\`
3. Thêm thư mục đó vào PATH, hoặc trỏ thẳng trong script cài đặt
4. Tạo tunnel (xem [DEPLOYMENT.md](DEPLOYMENT.md) phần Cloudflare)

---

## Cài đặt

```powershell
# Chạy PowerShell với quyền Administrator
cd C:\tailieu

# 1. Sao chép mã nguồn
git clone https://github.com/hoangtuvungcao/tailieu-web.git .
# hoặc giải nén từ tệp zip

# 2. Cấu hình môi trường
Copy-Item .env.production.example .env
notepad .env
```

Sửa `.env` cho Windows:

```bash
NODE_ENV=production
API_PUBLIC_URL=https://tailieu.5125121.com

# Chỉ loopback. Tunnel chạy cùng máy nên vẫn vào được, mà cả mạng LAN thì không.
# Đổi thành 0.0.0.0 là mở API cho LAN — xem giải thích ở TRUST_PROXY bên dưới.
API_HOST=127.0.0.1
# API nằm sau tunnel, nên Fastify nên biết điều đó (log, request.protocol).
# Biến này KHÔNG điều khiển địa chỉ dùng cho giới hạn tần suất.
TRUST_PROXY=true

DATABASE_URL=postgres://tailieu:<mật-khẩu>@127.0.0.1:5432/tailieu
REDIS_URL=redis://:<mật-khẩu-memurai>@127.0.0.1:6379

S3_ENDPOINT=http://127.0.0.1:8333
S3_ACCESS_KEY=<khớp với s3.json>
S3_SECRET_KEY=<khớp với s3.json>
S3_FORCE_PATH_STYLE=true

# BỐN khoá khác nhau. Sinh bằng:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
JWT_SECRET=...
JWT_REFRESH_SECRET=...
CSRF_SECRET=...
ARGON2_PEPPER=...

CORS_ORIGINS=https://tailieu.5125121.com
MAIL_DRIVER=smtp
```

```powershell
# 3. Cài dependencies và build
npm install
npm run build --workspace backend

# 4. Tạo bảng và dữ liệu mẫu
npm run db:migrate
npm run db:seed

# 5. Đăng ký service
cd deploy\windows
.\install-services.ps1 -InstallRoot C:\tailieu -NssmPath C:\tools\nssm\nssm.exe

# 6. Khởi động
Start-Service tailieu-api
Start-Service tailieu-worker
Start-Service tailieu-cleanup
```

---

## Kiểm tra

```powershell
# API sống chưa
Invoke-RestMethod http://localhost:4000/api/health

# Phải trả về JSON có đủ 7 khoa
Invoke-RestMethod http://localhost:4000/api/v1/taxonomy/faculties | Select-Object -ExpandProperty data | Measure-Object

# Tìm kiếm tiếng Việt không dấu (kiểm tra trigger bỏ dấu)
Invoke-RestMethod 'http://localhost:4000/api/v1/search/suggest?q=cong' | Select-Object -ExpandProperty data

# Đăng nhập
$body = @{ email = 'admin@tailieu.local'; password = '<mật-khẩu-đã-đổi>' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/v1/auth/login -Body $body -ContentType 'application/json'
```

Qua tunnel:

```powershell
Invoke-RestMethod https://api-internal.tailieu.5125121.com/api/health
```

Và quan trọng nhất — qua chính tên miền công khai:

```powershell
Invoke-RestMethod https://tailieu.5125121.com/api/health
```

Kiểm thử đầu-cuối đầy đủ (yêu cầu API và frontend đang chạy):

```powershell
# Terminal 1
npm run dev --workspace frontend

# Terminal 2
powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
```

---

## Bảo vệ

Máy chủ Windows dễ bị tấn công hơn máy chủ Linux vì mặc định mở nhiều thứ hơn.
Làm tối thiểu những việc sau.

### Tường lửa

Chỉ mở những cổng cần thiết. **Không** mở 4000, 5432, 6379, 8333 ra ngoài —
tunnel kết nối đi ra, nên không cần mở cổng nào cho lưu lượng vào.

```powershell
# Chặn toàn bộ lưu lượng vào theo mặc định
Set-NetFirewallProfile -Profile Domain,Public,Private -DefaultInboundAction Block

# Cho phép RDP nếu bạn cần quản trị từ xa (cân nhắc đổi cổng)
New-NetFirewallRule -DisplayName 'RDP' -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Allow
```

> Đừng mở 80/443. Cloudflare Tunnel không cần chúng — đó là toàn bộ lợi ích của
> tunnel: không có cổng nào lộ ra Internet.

### Giới hạn tài nguyên worker

Không có container, LibreOffice chạy chung máy với API. Giới hạn để một tài liệu
hỏng không làm treo cả máy chủ:

```powershell
# Giới hạn worker ở 2 nhân và 2 GB RAM
& C:\tools\nssm\nssm.exe set tailieu-worker AppAffinity 0 1
& C:\tools\nssm\nssm.exe set tailieu-worker AppPriority BELOW_NORMAL_PRIORITY_CLASS
```

NSSM không giới hạn được RAM trực tiếp. Nếu cần, dùng Windows Job Object hoặc
đặt `CONVERT_TIMEOUT_MS` thấp hơn (mặc định 120000) để một tài liệu hỏng bị giết
sớm hơn.

### Sao lưu

Xem [DEPLOYMENT.md](DEPLOYMENT.md) — lệnh `pg_dump` giống nhau, chỉ khác đường
dẫn. Đặt lịch bằng Task Scheduler:

```powershell
$action  = New-ScheduledTaskAction -Execute 'C:\tailieu\deploy\windows\backup.ps1'
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName 'TAILIEU Backup' -Action $action -Trigger $trigger -RunLevel Highest
```

---

## Xử lý sự cố

### Service khởi động rồi dừng ngay

```powershell
Get-Content C:\tailieu\logs\tailieu-api.error.log -Tail 40
```

Nguyên nhân thường gặp: `.env` thiếu biến, hoặc mật khẩu database sai. API **từ
chối khởi động** khi cấu hình sai thay vì chạy nửa vời — đọc thông báo lỗi, nó
nói rõ thiếu gì.

### `'NODE_ENV' is not recognized`

Bạn đang chạy script npm bằng `cmd`hoặc PowerShell mà script dùng cú pháp bash.
Các script trong dự án đã được sửa để chạy mọi nền tảng — nếu vẫn gặp, chạy
`npm install` lại để lấy `cross-env`.

### Xem trước tệp Word không bao giờ xong

```powershell
Get-Content C:\tailieu\logs\tailieu-worker.error.log -Tail 30
& "C:\Program Files\LibreOffice\program\soffice.exe" --version
```

Nếu `soffice --version` báo không tìm thấy, đặt `SOFFICE_PATH` trong `.env`.

Nếu chuyển đổi treo: kiểm tra `C:\tailieu\tmp\` có ghi được không. LibreOffice
cần thư mục tạm ghi được, và tài khoản chạy service phải có quyền.

### Máy chủ chậm dần rồi hết dung lượng

Phiên tải lên bỏ dở đang rò rỉ phần multipart. Chạy dọn dẹp thủ công:

```powershell
cd C:\tailieu\backend
npm run cleanup
```

Kiểm tra Task Scheduler có chạy `tailieu-cleanup` không, hoặc service đó có đang
chạy không (`Get-Service tailieu-cleanup`).

### Không kết nối được từ Internet

```powershell
Get-Service tailieu-tunnel
Get-Content C:\tailieu\logs\tailieu-tunnel.error.log -Tail 30
```

Kiểm tra `API_ORIGIN` trong Cloudflare Pages trỏ tới `api-internal...`, **không**
phải `tailieu...`.

---

## Những gì khác biệt so với bản Linux

| | Linux (Docker) | Windows 2012 R2 |
|---|---|---|
| Cách ly LibreOffice | Container riêng | Chung máy, chỉ giới hạn bằng affinity |
| Redis | Redis 7 | Memurai (tương thích 7.2.6) |
| Quản lý tiến trình | systemd | NSSM + Windows Service |
| Cập nhật | `docker compose pull` | `git pull` + `npm run build` + `Restart-Service` |
| Node | Được hỗ trợ | **Ngoài hỗ trợ** |
| Hỗ trợ OS | Đến 2027+ | Đã hết vòng đời 10/2023 |

---

## Khuyến nghị

Nếu có bất kỳ khả năng nào, hãy **nâng cấp máy chủ lên Windows Server 2019/2022**
hoặc **chuyển ngăn xếp sang một máy Linux**. Cả hai đều loại bỏ rủi ro Node ngoài
hỗ trợ, khôi phục lớp cách ly container, và cho phép dùng đúng
`docker-compose.yml` đã được kiểm chứng.

Ở lại 2012 R2 là được, nhưng bạn đang chạy một ngăn xếp Linux-native trên một hệ
điều hành đã hết vòng đời, với runtime ngoài hỗ trợ, và không có cách ly.
