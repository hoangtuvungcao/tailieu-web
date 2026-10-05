# Kiến trúc — TAILIEU TTN

Tài liệu này giải thích **các quyết định thiết kế và đánh đổi**. Không phải mô tả
mã nguồn — mã nguồn đã tự mô tả. Đây là những thứ chỉ đọc mã sẽ không hiểu được,
đặc biệt là **vì sao không làm theo cách hiển nhiên hơn**.

---

## 1. Ràng buộc định hình toàn bộ hệ thống

Ba ràng buộc từ đề bài, và mỗi cái đều ép ra một quyết định kiến trúc cụ thể.

### 1.1 Backend chạy trên laptop, không có IP tĩnh

**Hệ quả:** không được có bất cứ thứ gì công khai trỏ tới một địa chỉ IP.

**Giải pháp:** Cloudflare Tunnel. Tunnel chỉ mở kết nối **đi ra**, nên không cần
mở cổng trên router. Laptop đổi IP, đổi mạng, đóng máy rồi mở lại — tunnel tự kết
nối lại. Không cấu hình nào phải sửa.

### 1.2 Frontend trên Cloudflare Pages, API ở nơi khác

**Hệ quả:** hai thứ ở hai nơi, nhưng phải trông như một.

**Giải pháp:** một **Pages Function** chuyển tiếp `/api/*` tới tunnel. Nhờ vậy
trình duyệt thấy **một origin duy nhất**:

- Không có CORS. Không có preflight. Không có cấu hình CORS để làm sai.
- Cookie làm mới là **first-party**, nên `SameSite=Lax` hoạt động đúng như thiết kế.
  Nếu API ở subdomain khác, `SameSite=Lax` sẽ chặn cookie trên request cross-site
  và người dùng bị đăng xuất liên tục.

**Hai hostname, hai vai trò:**

| Hostname | Phục vụ bởi |
|---|---|
| `tailieu.5125121.com` | Cloudflare Pages |
| `api-internal.tailieu.5125121.com` | Cloudflare Tunnel |

> Đây là chỗ dễ cấu hình sai nhất. Gán `tailieu.5125121.com` cho tunnel sẽ **che
> mất frontend**. Trỏ `API_ORIGIN` về `tailieu.5125121.com` sẽ khiến Worker **gọi
> lại chính nó** thành vòng lặp vô tận.

### 1.3 Cloudflare giới hạn 100MB mỗi request

**Hệ quả:** tệp lớn **không thể** đi qua proxy trong một request. Đây là giới hạn
cứng của hạ tầng, không phải lựa chọn thiết kế.

**Giải pháp:** tải lên **chia phần**. ~8MB mỗi phần, ghép ở phía server bằng S3
multipart upload.

Đây không phải tính năng "nice to have" — với một luận văn scan 300MB, đây là
**cách duy nhất để tải lên được**. Chia phần còn mang lại khả năng **tiếp tục**
sau khi mất kết nối như một tác dụng phụ, mà với một laptop sau đường truyền gia
đình thì mất kết nối là chuyện thường ngày, không phải ngoại lệ.

---

## 2. Những lớp trừu tượng, và vì sao chúng tồn tại

Mỗi lớp dưới đây đều có một lý do cụ thể. Chúng không phải "kiến trúc cho đẹp".

### 2.1 `StorageDriver` — đã trả công ngay lập tức

```ts
interface StorageDriver {
  putStream(...): Promise<PutStreamResult>;
  signedDownloadUrl(...): Promise<string>;
  createMultipartUpload(...): Promise<MultipartInit>;
  // …
}
```

**Lý do ban đầu:** cho phép chuyển từ lưu trữ cục bộ sang S3-compatible mà không
viết lại.

**Đã trả công thế nào:** kế hoạch ban đầu dùng **MinIO**. MinIO sau đó **ngừng phát
hành bản community** — xoá image khỏi Docker Hub, ngừng pull ẩn danh trên Quay,
`dl.min.io` trả 410, kho lưu trữ bị archive, và **CVE-2025-62506 không được vá**.

Chuyển sang **SeaweedFS** tốn: **một service trong docker-compose và hai biến môi
trường**. Không một dòng mã ứng dụng nào phải sửa.

Nếu không có lớp này, đó sẽ là một tuần làm việc.

### 2.2 `SearchProvider` — để thừa nhận giới hạn

```ts
interface SearchProvider {
  search(request: SearchRequest): Promise<SearchResult>;
  suggest(prefix: string, limit: number): Promise<SearchSuggestion[]>;
  indexDocument(documentId: string): Promise<void>;
  // …
}
```

**Đánh giá thẳng thắn:** tìm kiếm là **phần yếu nhất** của hệ thống. PostgreSQL
không có bộ tách từ tiếng Việt. Xếp hạng là `ts_rank_cd` trên vector `simple` đã
bỏ dấu — khớp cả từ tốt, khớp một phần từ nhờ trigram, nhưng **không có** sửa lỗi
gõ, đồng nghĩa, hay khoảng cách cụm từ.

Đó **chính xác là lý do** interface này tồn tại. Chuyển sang Meilisearch cần: một
lớp mới implement interface, và một nhánh `case` trong factory. Không controller,
service hay route nào phải sửa — vì không có chỗ nào biết backend nào đang chạy.

**Điều kiện để lớp này còn giá trị:** khoảnh khắc ai đó viết `ILIKE` trực tiếp
trong controller, việc chuyển đổi từ "thay một lớp" thành "viết lại" — vì ngữ nghĩa
xếp hạng và từ vựng bộ lọc giờ nằm rải rác ở nơi gọi.

### 2.3 `Mailer` — vì chưa có SMTP

Chưa có thông tin đăng nhập SMTP, nên driver mặc định là `console`. Interface cho
phép xây dựng và **kiểm thử** luồng xác minh email và đặt lại mật khẩu **ngay bây
giờ**, thay vì chờ có nhà cung cấp mail.

> `env.ts` **từ chối khởi động** với `MAIL_DRIVER=console` trong production. Chủ ý:
> email đặt lại mật khẩu in ra log và không bao giờ được gửi nghĩa là người dùng
> không thể khôi phục tài khoản — **và không có lỗi nào hiện ra** để ai đó nhận ra.

### 2.4 `PreviewResolver` — tách quyết định khỏi thực thi

```ts
resolvePreview(file) → { kind: 'pdf'|'image'|'text'|'office'|'none', inline, conversion }
```

Hàm **thuần, đồng bộ**, gọi được trên mọi lần đọc mà không chạm database. Nó
**quyết định**; worker **thực thi**. Việc tách này ngăn preview trở thành một
pipeline chuyển đổi lẫn vào tầng đọc.

`kind: 'none'` là **cố ý rõ ràng**. Một resolver ném lỗi, hoặc trả URL sẽ 404, tạo
ra lỗi người dùng không xử lý được. Trả về "định dạng này không xem trước được, đây
là nút tải xuống" là sản phẩm tốt hơn **và** trung thực hơn.

---

## 3. Bảo mật — các quyết định kiến trúc

Chi tiết đầy đủ ở [`SECURITY.md`](SECURITY.md). Ở đây chỉ nêu các quyết định
**định hình kiến trúc**.

### 3.1 Quyền KHÔNG nằm trong JWT

Token truy cập chứa `{sub, sid, tv, roles}` — **không chứa danh sách quyền**.

**Vì sao:** một người có vai trò `admin` giữ **47 quyền**. Nhúng hết vào JWT làm
mọi header request phình ra vô ích. Nhưng lý do quan trọng hơn là **thu hồi**: token
15 phút mang quyền đóng băng nghĩa là tước quyền một kiểm duyệt viên phải chờ tới
15 phút mới có hiệu lực.

Quyền được giải quyết ở server mỗi request, cache trong Redis (TTL 300s, vô hiệu
hoá bằng bộ đếm phiên bản). Thu hồi có hiệu lực **ngay lập tức**.

### 3.2 Token làm mới là mờ (opaque), không phải JWT

JWT tự mô tả và tự xác thực — **đúng thứ không cần** ở đây. Cần server **thu hồi
được** token, và cần **tra database mỗi lần dùng** để phát hiện việc dùng lại một
token đã xoay vòng. JWT không cho cả hai.

Chỉ lưu `sha256(raw)`. Cùng lý do áp dụng cho mật khẩu, và thường bị bỏ qua với
token.

### 3.3 Backend thực thi, frontend chỉ gợi ý

Frontend ẩn nút để tránh hiện lỗi; nó **không phải** biện pháp kiểm soát. Mọi
endpoint tự kiểm tra lại. Bỏ qua `RequireAuth` trong devtools chỉ hiện ra một trang
mà các truy vấn dữ liệu của nó thất bại.

### 3.4 Phân quyền theo khoa thực thi trong SQL

`faculty_moderator` là chỗ duy nhất quyền được cấp **có điều kiện theo hàng**. Điều
kiện đó nằm trong `WHERE`, **không phải** lọc kết quả sau khi truy vấn.

**Vì sao:** nếu repository trả về hàng người dùng không được xem và trông cậy vào
tầng service để lọc, thì **một lần quên lọc** — trong module này, trong search,
trong job export, trong trang quản trị — là rò rỉ. Đặt vị từ trong SQL nghĩa là
hàng **không bao giờ được nạp**, nên không có gì để quên.

---

## 4. Cấu trúc module

```
modules/<tên>/
  ├── <tên>.route.ts        HTTP verbs + gắn preHandler. Không logic.
  ├── <tên>.controller.ts   HTTP ↔ DTO. Không SQL.
  ├── <tên>.service.ts      Nghiệp vụ, quyết định phân quyền, transaction.
  ├── <tên>.repository.ts   Toàn bộ SQL. Không HTTP.
  ├── <tên>.schema.ts       Kiểm tra đầu vào (Zod).
  └── <tên>.mapper.ts       Ánh xạ hàng → DTO (chỉ khi cần, VD documents)
```

**Quy tắc:** SQL chỉ nằm trong repository. HTTP chỉ nằm trong controller. Điều này
không phải nghi thức — nó là thứ khiến `visibilityPredicate` có thể tồn tại ở **một
chỗ duy nhất** và được dùng lại bởi danh sách, chi tiết, tải xuống, xem trước **và**
tìm kiếm mà không có nguy cơ lệch nhau.

### Mapper là ranh giới bảo mật

`documents.mapper.ts` là ví dụ rõ nhất. Nó **không** phải tiện ích định dạng — nó
xây dựng DTO từ danh sách trường **tường minh**.

**Vì sao:** một hàng tài liệu join tới `storage_objects`, nơi có `bucket` và
`object_key`. Hai giá trị đó là thứ duy nhất đứng giữa người dùng và **mọi tệp trên
nền tảng**. Nếu controller trả về hàng thô, thêm một cột vào lược đồ sẽ **tự động**
rò rỉ nó ra API. Với mapper, một trường chỉ xuất hiện khi ai đó **cố ý** viết nó vào.

---

## 5. Vì sao chọn các công nghệ này

| Chọn | Thay vì | Lý do |
|---|---|---|
| **Drizzle** | Prisma | Lược đồ này phụ thuộc vào chỉ mục duy nhất **một phần**, cột `tsvector` sinh tự động, chỉ mục biểu thức GIN/trgm, và `UNIQUE NULLS NOT DISTINCT`. Prisma chống lại những thứ đó; Drizzle diễn đạt được **và** vẫn sinh SQL đọc được, sửa tay được. |
| **Fastify** | Express | Xác thực lược đồ, plugin, và hiệu năng. Nhưng quan trọng hơn: `app.inject()` cho phép test tích hợp chạy thẳng trên ứng dụng thật mà không cần mở cổng. |
| **PostgreSQL FTS** | Elasticsearch | Không thêm một service để vận hành trên một chiếc laptop. Đủ tốt để bắt đầu, và nằm sau một interface. |
| **Redis list** | BullMQ / RabbitMQ | Một loại job, một consumer. Broker chỉ thêm phụ thuộc vận hành mà không thêm khả năng. |
| **Argon2id** | bcrypt | Kháng GPU tốt hơn; bcrypt giới hạn 72 byte và không có tham số bộ nhớ. |
| **jose** | jsonwebtoken | Hỗ trợ TypeScript tốt hơn, và thuật toán được **ghim** khi xác minh. |
| **SeaweedFS** | MinIO | Xem [§2.1](#21-storagedriver--đã-trả-công-ngay-lập-tức). |

### Vì sao converter là container riêng

LibreOffice ngốn RAM, thỉnh thoảng treo, và **mở tài liệu không đáng tin** như một
nghề. Tách riêng nghĩa là trường hợp xấu nhất là **preview bị treo**, không phải
**đăng nhập bị treo**.

Nó cũng **từ chối khởi động** nếu thiếu LibreOffice. Một worker khởi động mà không
có soffice sẽ nhận job, làm hỏng tất cả, và đẩy cả hàng đợi vào dead-letter — tệ
hơn nhiều so với việc từ chối chạy, vốn hiện ra ngay lập tức.

---

## 6. Những thứ CỐ Ý không xây

Ghi lại để lần sau không ai phải đoán lại.

| Không xây | Vì sao |
|---|---|
| **Microservices** | Một laptop. Một tiến trình API, một worker. Ranh giới module đã đủ rõ để tách sau này nếu cần. |
| **GraphQL** | REST với envelope thống nhất đáp ứng đủ, và dễ suy luận hơn về phân quyền và giới hạn tần suất. |
| **Event sourcing** | Không có yêu cầu nào cần tới. `audit_logs` và `document_moderation_events` đã ghi lại lịch sử cần thiết. |
| **Chuyển đổi Office đồng bộ** | Một request HTTP không nên chờ LibreOffice. Job nền + trạng thái `queued/ready/failed` cho phép UI nói "đang xử lý" một cách trung thực. |
| **`drizzle-kit push`** | So sánh lược đồ và **có thể xoá cột**. Trên database chứa tài liệu thật, đó là mất dữ liệu. Chỉ dùng khi thử nghiệm cục bộ. |
| **Đa tenant ngay từ đầu** | Đề bài yêu cầu hỗ trợ về sau. `tenant_id` đã có chỗ trên bảng taxonomy (luôn `NULL`, **không bao giờ** được tham chiếu trong mã). Thêm trường thứ hai là migration + chỉ mục một phần, **không phải viết lại**. |

---

## 7. Luồng của một tệp tải lên

Ví dụ cụ thể để thấy các mảnh ghép lại với nhau.

```
1. POST /uploads                    → tạo upload_sessions + S3 multipart
   ← { uploadId, chunkSize, totalChunks }

2. PUT /uploads/:id/chunks/:i  (×N) → mỗi phần ≤8MB, thân nhị phân thô
   ├─ Magic byte của phần 0 → xác định loại thật → từ chối nếu không hợp lệ
   ├─ Stream thẳng tới S3 multipart part (không đệm vào bộ nhớ)
   └─ Ghi upload_chunks (idempotent theo (session_id, chunk_index))

3. POST /uploads/:id/complete       → ghép, rồi:
   ├─ Stream đối tượng đã ghép qua SHA-256 (bộ nhớ O(1))
   ├─ Tra storage_objects theo content_hash
   │   ├─ Đã có → xoá bản vừa ghép (tiết kiệm dung lượng)
   │   └─ Chưa có → chèn storage_objects
   └─ Nếu là định dạng Office → đẩy job vào Redis

4. POST /documents                  → tạo tài liệu, gắn tệp, tăng ref_count (1 transaction)

5. Converter worker (nền)           → tải về, chuyển PDF, tải lên, cập nhật
                                      preview_status = 'ready'
```

**Vì sao đẩy job SAU khi transaction commit:** đẩy job bên trong transaction sẽ
để lại một job trỏ tới hàng mà rollback đã xoá — worker sẽ hỏng mãi mãi trên một
tệp không tồn tại.

**Vì sao hash bằng cách đọc lại đối tượng đã ghép:** SHA-256 không ghép được từ
hash của từng phần, và các phần có thể đến **không theo thứ tự**. Đây là một lần
đọc toàn bộ tệp — bộ nhớ O(1) nhưng có I/O thật, và là **ứng viên đầu tiên để tối
ưu** nếu việc hoàn tất tải lên trở thành điểm nghẽn.
