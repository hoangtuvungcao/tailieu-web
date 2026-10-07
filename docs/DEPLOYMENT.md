# Triển khai — TAILIEU TTN

Hướng dẫn này đưa hệ thống từ mã nguồn tới chạy thật tại
`https://tailieu.5125121.com`, với backend trên một laptop/máy chủ sau
Cloudflare Tunnel.

**Đọc hết phần [Chuẩn bị](#0-chuẩn-bị) trước khi bắt đầu.** Sai ở bước 1 hoặc 2
là nguyên nhân phổ biến nhất khiến hệ thống không hoạt động.

---

## Kiến trúc triển khai

```
Internet
    │
    ▼
Cloudflare
    ├─ tailieu.5125121.com/       ─▶ Cloudflare Pages   (tệp tĩnh, React SPA)
    └─ tailieu.5125121.com/api/*  ─▶ Pages Function
                                          │
                                          ▼
                              api-internal.tailieu.5125121.com
                                          │
                                   Cloudflare Tunnel
                                          │
                                     (outbound only)
                                          │
                                    localhost:4000
                                          │
                                    ┌─────┴─────┐
                                PostgreSQL    SeaweedFS
                                   Redis      Converter
```

**Hai hostname, hai vai trò — đừng nhầm lẫn:**

| Hostname | Phục vụ bởi | Công khai? |
|---|---|---|
| `tailieu.5125121.com` | Cloudflare Pages | ✅ Người dùng truy cập |
| `api-internal.tailieu.5125121.com` | Cloudflare Tunnel | ❌ Chỉ Pages Function gọi |

Tunnel chỉ mở kết nối **đi ra**. Không cần mở cổng trên router, không cần IP
tĩnh. Nếu IP của laptop đổi, tunnel tự kết nối lại — không cấu hình gì phải sửa.

---

## 0. Chuẩn bị

**Trên máy chủ:**

- Ubuntu 22.04+ (hoặc tương đương), Docker + Docker Compose
- Node.js ≥ 20
- Tên miền `5125121.com` đã thêm vào Cloudflare (nameserver đã trỏ về Cloudflare)

**Kiểm tra nhanh:**

```bash
docker --version          # cần Docker 24+
node --version            # cần v20+
dig +short NS 5125121.com # phải trả về *.ns.cloudflare.com
```

Nếu `dig` không trả về nameserver của Cloudflare, **dừng lại** — tunnel và Pages
đều yêu cầu tên miền nằm trong Cloudflare.

---

## 1. Chuẩn bị máy chủ

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin tailieu
sudo mkdir -p /opt/tailieu /var/log/tailieu /etc/tailieu
sudo chown -R tailieu:tailieu /opt/tailieu /var/log/tailieu
```

```bash
sudo -u tailieu git clone https://github.com/hoangtuvungcao/tailieu-web.git /opt/tailieu
cd /opt/tailieu
sudo -u tailieu npm install --omit=dev --workspace backend
sudo -u tailieu npm run build --workspace backend
```

### Cấu hình môi trường

```bash
sudo install -m 600 .env.production.example /etc/tailieu/api.env
sudo -e /etc/tailieu/api.env
```

Điền tối thiểu:

```bash
NODE_ENV=production
API_PUBLIC_URL=https://tailieu.5125121.com

# Sinh bằng: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# BỐN giá trị KHÁC NHAU. Hệ thống từ chối khởi động nếu trùng nhau.
JWT_SECRET=...
JWT_REFRESH_SECRET=...
CSRF_SECRET=...
ARGON2_PEPPER=...

DATABASE_URL=postgres://...
REDIS_URL=redis://...
S3_ENDPOINT=...
S3_ACCESS_KEY=...
S3_SECRET_KEY=...

CORS_ORIGINS=https://tailieu.5125121.com
MAIL_DRIVER=smtp
SMTP_HOST=...
```

> **`ARGON2_PEPPER` phải được sao lưu riêng.** Nó không nằm trong hash mật khẩu,
> nên mất giá trị này là **mất toàn bộ mật khẩu** — kể cả khi còn nguyên database.
> Cất nó ở nơi khác với bản sao lưu database.

> **`MAIL_DRIVER=console` sẽ khiến `env.ts` từ chối khởi động** trong production.
> Đây là chủ ý: email đặt lại mật khẩu in ra log và không bao giờ được gửi nghĩa
> là người dùng không thể khôi phục tài khoản, mà không có lỗi nào hiện ra.

### Cơ sở dữ liệu

```bash
cd /opt/tailieu
sudo -u tailieu docker compose up -d postgres redis seaweedfs
sudo -u tailieu npm run db:migrate
sudo -u tailieu npm run db:seed     # lần đầu; chạy lại cũng an toàn
```

`db:seed` in ra mật khẩu tài khoản quản trị. **Đổi ngay sau lần đăng nhập đầu.**

---

## 2. systemd

```bash
sudo cp deploy/systemd/tailieu-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tailieu-api
sudo systemctl status tailieu-api
```

Kiểm tra cục bộ trước khi động tới Cloudflare:

```bash
curl -s http://localhost:4000/api/health | head -c 200
```

Phải trả về `{"success":true,...}`. Nếu không, xem log:

```bash
sudo journalctl -u tailieu-api -n 50 --no-pager
sudo tail -50 /var/log/tailieu/api.error.log
```

**Chưa tiếp tục cho tới khi lệnh `curl` này chạy được.** Gỡ lỗi qua tunnel khó
hơn nhiều.

---

## 3. Cloudflare Tunnel

> Phần này viết cho **Linux**. Nếu máy chủ API chạy Windows Server 2012 R2, dùng
> [SETUP_WINDOWS_PAGES.md](SETUP_WINDOWS_PAGES.md) phần A4 — các lệnh ở đây
> (`dpkg`, `/etc/cloudflared`, `systemctl`) không dùng được ở đó, và
> `cloudflared service install` trên Windows còn có một cái bẫy riêng.

### Cài đặt

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared --version
```

### Đăng nhập và tạo tunnel

```bash
cloudflared tunnel login          # mở trình duyệt, chọn tên miền 5125121.com
cloudflared tunnel create tailieu-api
```

Lệnh cuối in ra **Tunnel UUID** và tạo file thông tin xác thực. Ghi lại UUID.

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<UUID>.json /etc/cloudflared/
sudo cp deploy/cloudflared/config.yml /etc/cloudflared/config.yml
sudo -e /etc/cloudflared/config.yml    # thay REPLACE_WITH_TUNNEL_UUID bằng UUID thật
```

### Trỏ DNS

```bash
cloudflared tunnel route dns tailieu-api api-internal.tailieu.5125121.com
```

Lệnh này tạo bản ghi CNAME trỏ hostname nội bộ về tunnel.

> **Không** chạy lệnh này cho `tailieu.5125121.com`. Hostname đó thuộc Cloudflare
> Pages; gán nó cho tunnel sẽ che mất frontend.

### Chạy như dịch vụ

```bash
sudo cloudflared service install
sudo systemctl enable --now tailieu-tunnel
```

Hoặc dùng unit có sẵn trong repo (khuyến nghị — đã cấu hình hardening):

```bash
sudo cp deploy/systemd/tailieu-tunnel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tailieu-tunnel
```

### Kiểm tra

```bash
systemctl status tailieu-tunnel
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://api-internal.tailieu.5125121.com/api/health

curl -s https://api-internal.tailieu.5125121.com/api/health
```

Lệnh cuối phải trả về JSON. Nếu nhận 502, backend chưa chạy hoặc sai cổng.

---

## 4. Cloudflare Pages

### Tạo dự án

Bảng điều khiển Cloudflare → **Workers & Pages** → **Create** → **Pages** →
**Connect to Git** → chọn repository `tailieu-web`.

Cấu hình build:

| Trường | Giá trị |
|---|---|
| Framework preset | None (cấu hình thủ công) |
| Root directory | `frontend` |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |

### Biến môi trường

**Settings → Environment variables** (đặt cho cả Production *và* Preview):

| Biến | Giá trị |
|---|---|
| `API_ORIGIN` | `https://api-internal.tailieu.5125121.com` |
| `VITE_API_URL` | `/api/v1` |

> **`API_ORIGIN` không bao giờ được là `https://tailieu.5125121.com`.** Worker
> chạy trên chính hostname đó; trỏ về nó tạo vòng lặp gọi chính mình cho tới khi
> Cloudflare cắt ở giới hạn subrequest.

> **`VITE_API_URL` phải là đường dẫn tương đối `/api/v1`**, không phải URL đầy
> đủ. Frontend và API cùng origin; dùng URL tuyệt đối sẽ biến mọi request thành
> cross-origin và cookie phiên sẽ không được gửi.

### Tên miền

**Custom domains** → thêm `tailieu.5125121.com`. Cloudflare tự tạo bản ghi DNS.

### Triển khai

```bash
git push origin main
```

Pages tự build và triển khai.

---

## 5. Kiểm tra sau triển khai

Chạy lần lượt. **Đừng bỏ qua bước nào.**

```bash
# 1. Frontend phục vụ được
curl -s -o /dev/null -w "%{http_code}\n" https://tailieu.5125121.com/
# → 200

# 2. Yêu cầu bắt buộc của đề bài — API công khai hoạt động
curl -s https://tailieu.5125121.com/api/health
# → {"success":true,"data":{"status":"ok",...}}

# 3. Proxy chuyển tiếp đúng tới backend
curl -s "https://tailieu.5125121.com/api/v1/taxonomy/faculties?limit=3"
# → danh sách 7 khoa

# 4. Tìm kiếm tiếng Việt không dấu hoạt động qua tunnel
curl -s "https://tailieu.5125121.com/api/v1/search/suggest?q=cong"
# → gợi ý "Công nghệ thông tin"

# 5. Cookie phiên được đặt đúng (kiểm tra HttpOnly và SameSite)
curl -s -D - -o /dev/null -X POST https://tailieu.5125121.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@tailieu.local","password":"<mật khẩu đã đổi>"}' \
  | grep -i set-cookie
# → rt=...; HttpOnly; SameSite=Lax   và   csrf=...; SameSite=Lax  (csrf KHÔNG HttpOnly)
```

### Danh sách kiểm tra thủ công

- [ ] Đăng ký tài khoản mới qua giao diện
- [ ] Đăng nhập, tải lại trang — vẫn đăng nhập (refresh cookie hoạt động)
- [ ] Tải lên một tệp PDF, xem trước được
- [ ] Tải lên một tệp Word, chờ vài giây, xem trước được (converter hoạt động)
- [ ] Tìm kiếm không dấu ra kết quả có dấu
- [ ] Đăng xuất — không truy cập được trang yêu cầu đăng nhập

---

## 6. Sao lưu

Máy chủ là một chiếc laptop. **Sao lưu không phải tuỳ chọn.**

### Cơ sở dữ liệu

```bash
#!/usr/bin/env bash
# /opt/tailieu/scripts/backup-db.sh
set -euo pipefail

BACKUP_DIR=/var/backups/tailieu
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

docker exec tailieu-postgres pg_dump -U tailieu -Fc tailieu \
  > "$BACKUP_DIR/tailieu-$STAMP.dump"

# Giữ 30 bản gần nhất
find "$BACKUP_DIR" -name 'tailieu-*.dump' -mtime +30 -delete

echo "Đã sao lưu: $BACKUP_DIR/tailieu-$STAMP.dump"
```

```bash
sudo chmod +x /opt/tailieu/scripts/backup-db.sh
sudo crontab -e
# 3 giờ sáng mỗi ngày
0 3 * * * /opt/tailieu/scripts/backup-db.sh >> /var/log/tailieu/backup.log 2>&1
```

### Công việc bảo trì định kỳ

Có một job dọn dẹp phải chạy thường xuyên. **Không chạy nó thì hạ tầng rò rỉ
âm thầm** — không có lỗi nào hiện ra, chỉ là dung lượng ổ đĩa tăng dần.

```bash
sudo crontab -e
# 4 giờ sáng mỗi ngày
0 4 * * * cd /opt/tailieu/backend && /usr/bin/npm run cleanup >> /var/log/tailieu/cleanup.log 2>&1
```

Job này làm bốn việc:

| Việc | Vì sao quan trọng |
|---|---|
| **Huỷ các phiên tải lên bỏ dở** | Phần của S3 multipart **không xuất hiện trong danh sách đối tượng** và không được tính là đối tượng. Một tệp 300MB bị bỏ dở giữa đường sẽ chiếm dung lượng **vĩnh viễn** và không có gì khác trong hệ thống phát hiện ra. |
| **Xoá token hết hạn** | Bảng `refresh_tokens` tăng một hàng mỗi lần làm mới. Đây là bảng tăng nhanh nhất trong lược đồ. |
| **Dọn phiên cũ** | Để danh sách "thiết bị đang đăng nhập" còn ý nghĩa. |
| **Báo cáo đối tượng mồ côi** | Chỉ **báo cáo**, không xoá. Xem bên dưới. |

**Các tuỳ chọn:**

```bash
npm run cleanup -- --dry-run              # chỉ báo cáo, không thay đổi gì
npm run cleanup -- --delete-orphans       # XOÁ đối tượng mồ côi (mặc định: không)
npm run cleanup -- --orphan-grace-hours=48
npm run cleanup -- --loop                 # chạy thường trú, 6 giờ một lần (nếu không có cron)
```

> **Xoá đối tượng mồ côi mặc định TẮT, và nên giữ như vậy cho tới khi bạn hiểu rõ.**
> Đây là thao tác duy nhất trong job phá huỷ dữ liệu người dùng thấy được, và
> `ref_count = 0` **một mình không đủ** để kết luận một đối tượng là rác — một tệp
> vừa tải lên xong có thể đang chờ transaction gắn vào tài liệu commit. Vì vậy cần
> **cả** cờ tường minh **và** ngưỡng thời gian (mặc định 24 giờ).
>
> Quy trình an toàn: chạy báo cáo vài ngày, xem con số có hợp lý không, **rồi mới**
> bật xoá.

Theo dõi dung lượng lưu trữ:

```bash
npm run cleanup -- --dry-run 2>&1 | tail -1 | python3 -m json.tool
```

Trường `storage.shared` cho biết số đối tượng được **nhiều tài liệu dùng chung** —
đó là bằng chứng khử trùng lặp đang thực sự tiết kiệm dung lượng, chứ không phải
một lời khẳng định chưa ai kiểm chứng.

### Tệp tài liệu (SeaweedFS)

Dữ liệu nằm trong Docker volume `tailieu-ttn_seaweedfs_data`.

```bash
docker run --rm \
  -v tailieu-ttn_seaweedfs_data:/data:ro \
  -v /var/backups/tailieu:/backup \
  alpine tar czf /backup/seaweedfs-$(date +%Y%m%d).tar.gz -C /data .
```

> **Chưa kiểm thử khôi phục thì chưa gọi là sao lưu.** Mỗi quý, khôi phục một bản
> vào môi trường tạm và xác nhận ứng dụng chạy được.

### Cấu hình

```bash
sudo tar czf /var/backups/tailieu/config-$(date +%Y%m%d).tar.gz \
  /etc/tailieu /etc/cloudflared
```

`/etc/tailieu/api.env` chứa `ARGON2_PEPPER`. **Mã hoá bản sao lưu này** và cất
tách khỏi bản sao lưu database — hai thứ cùng mất thì không cứu được.

### Khôi phục

```bash
# Dừng API để không có ghi nào xen vào
sudo systemctl stop tailieu-api

docker exec -i tailieu-postgres pg_restore -U tailieu -d tailieu --clean --if-exists \
  < /var/backups/tailieu/tailieu-20261004-030000.dump

sudo systemctl start tailieu-api

# Kiểm tra
curl -s http://localhost:4000/api/health/db
```

---

## 7. Xử lý sự cố

### `/api/health` trả 502

Tunnel chạy nhưng backend không phản hồi.

```bash
sudo systemctl status tailieu-api
curl -s http://localhost:4000/api/health
sudo journalctl -u tailieu-api -n 30 --no-pager
```

Nguyên nhân thường gặp: API chưa khởi động, hoặc sai `API_PORT` trong
`/etc/tailieu/api.env`.

### Giao diện tải được nhưng mọi request API đều lỗi

`API_ORIGIN` trong Pages sai, hoặc thiếu.

```bash
# Xem log Function
# Cloudflare dashboard → Pages → dự án → Functions → Real-time logs
```

Kiểm tra `API_ORIGIN` trỏ tới `api-internal...`, **không** phải `tailieu...`.

### Tải lên thất bại ở tệp lớn

Cloudflare giới hạn **100MB mỗi request**. Ứng dụng chia nhỏ thành từng phần
~8MB, nên giới hạn này không được chạm tới. Nếu vẫn lỗi:

```bash
# Kiểm tra kích thước phần có bị đổi không
grep UPLOAD_CHUNK_SIZE /etc/tailieu/api.env
# Phải ≤ 8388608
```

### Xem trước tệp Word không bao giờ sẵn sàng

```bash
docker logs tailieu-converter --tail 50
docker exec -i tailieu-redis redis-cli llen preview:queue
docker exec -i tailieu-redis redis-cli llen preview:dead
```

Nếu `preview:dead` tăng, xem lý do trong log. Thử lại các job đã chết:

```bash
cd /opt/tailieu/backend
npx tsx -e "
import { retryDeadLetters } from './src/lib/preview/queue.js';
retryDeadLetters().then(n => { console.log('đã đưa lại', n, 'job'); process.exit(0); });
"
```

### Ổ đĩa đầy dần dù không có ai tải lên

Phiên tải lên bỏ dở đang rò rỉ phần multipart.

```bash
cd /opt/tailieu/backend && npm run cleanup -- --dry-run
docker exec -i tailieu-redis redis-cli llen preview:queue
du -sh /var/lib/docker/volumes/tailieu-ttn_seaweedfs_data
```

Nếu `orphansFound` lớn, chạy không có `--dry-run` để dọn. Nếu nó vẫn tăng đều,
kiểm tra rằng cron ở trên thực sự đang chạy.

### Người dùng bị đăng xuất liên tục

Thường do **đồng hồ hệ thống lệch** giữa máy chủ và Cloudflare, khiến token bị
coi là hết hạn ngay khi phát hành.

```bash
timedatectl status        # kiểm tra "System clock synchronized: yes"
sudo systemctl restart systemd-timesyncd
```

### Đăng nhập được nhưng tải lại trang là mất phiên

Cookie `rt` không được gửi. Kiểm tra:

```bash
curl -s -D - -o /dev/null -X POST https://tailieu.5125121.com/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"...","password":"..."}' | grep -i set-cookie
```

Cookie phải có `Secure` (vì production dùng HTTPS) và đường dẫn
`Path=/api/v1/auth`. Nếu thiếu `Secure`, kiểm tra `NODE_ENV=production` trong
`/etc/tailieu/api.env`.

---

## 8. Nâng cấp

```bash
cd /opt/tailieu
sudo -u tailieu git pull
sudo -u tailieu npm install --omit=dev --workspace backend
sudo -u tailieu npm run build --workspace backend
sudo -u tailieu npm run db:migrate      # luôn chạy trước khi khởi động lại
sudo systemctl restart tailieu-api
curl -s https://tailieu.5125121.com/api/health
```

Frontend tự triển khai khi push lên `main`.

> **Luôn sao lưu database trước khi migrate.** Migration chỉ chạy tiến, không có
> bước lùi tự động.

---

## Phụ lục: các quyết định thiết kế then chốt

Những điều dưới đây trông như chi tiết nhỏ nhưng là nguyên nhân của phần lớn sự
cố triển khai.

| Quyết định | Lý do |
|---|---|
| Tunnel trên hostname **nội bộ** | `tailieu.5125121.com` thuộc Pages. Gán nó cho tunnel sẽ che frontend. |
| `API_ORIGIN` trỏ tới tunnel, không phải site | Trỏ về site là Worker gọi chính nó → vòng lặp. |
| `VITE_API_URL=/api/v1` (tương đối) | Cùng origin ⇒ không CORS, cookie first-party. URL tuyệt đối phá cả hai. |
| Chia nhỏ tệp tải lên ~8MB | Giới hạn 100MB của Cloudflare là cứng; đây là cách duy nhất tải tệp lớn. |
| Function **stream** thân request | Đọc vào bộ nhớ sẽ vượt giới hạn Worker (lỗi 1102). |
| `duplex: 'half'` khi gọi fetch | Bắt buộc theo spec khi thân request là stream. |
| Bốn khoá bí mật khác nhau | Dùng chung một khoá nghĩa là một lần rò rỉ phá cả ba lớp. |
| Converter **từ chối khởi động** nếu thiếu LibreOffice | Nhận job rồi hỏng hết sẽ đẩy toàn bộ hàng đợi vào dead-letter. |
| `S3_FORCE_PATH_STYLE` khác nhau theo nhà cung cấp | SeaweedFS cần `true`, R2 cần `false`. Sai → lỗi chữ ký khó đoán. |
| Render trang ảnh tối ưu (Poppler `pdftoppm`) | Thay vì tải cả file PDF hàng chục MB về client gây đơ lag và tốn 4G, server tách từng trang thành ảnh ~40KB giúp mở tức thì trong 0.2s - 0.5s. |
