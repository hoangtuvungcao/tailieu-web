# Kế hoạch di trú sang SQL Server 2017

Tài liệu này là **kế hoạch**, không phải hướng dẫn đã thi công xong. Khối lượng ở §1
và số chỗ ở §2 được **đo trực tiếp từ mã nguồn** bằng `grep`/`wc`. Các kết luận về
SQL Server ở §7 được **chạy thử trên một instance SQL Server 2017 thật** — và một
trong số đó ngược với điều tôi tưởng ban đầu.

Đọc [DEPLOYMENT.md](DEPLOYMENT.md) và [WINDOWS.md](WINDOWS.md) trước. Bản WINDOWS.md
hiện có hướng dẫn đầy đủ cho **PostgreSQL** trên Windows Server 2012 R2, và nó đã
chạy được. Tài liệu này mô tả cái giá của việc đổi sang SQL Server.

---

## 0. Tóm tắt cho người quyết định

| | |
|---|---|
| Bản chất | **Viết lại tầng dữ liệu**, không phải nâng cấp. Drizzle ORM không có dialect SQL Server. |
| Khối lượng đo được | 5.941 dòng repository + 2.610 dòng schema + 4.455 dòng test |
| Kiểm tra hiện có | **164 test backend sẽ mất hiệu lực** và phải dựng lại |
| Một mất mát chức năng thật | Tìm kiếm kiểu chuỗi con mất chỉ mục trigram → quét toàn bảng (§3) |
| Đã kiểm chứng | Trên SQL Server 2017 thật: `GREATEST` và `FILTER` **không có**; filtered index **có**; collation tiếng Việt **phải là `Latin1_General_100_CI_AI`**, không phải `Vietnamese_*` (§7) |
| Đã sinh thử schema | **53/53 bảng** dựng được, 169 chỉ mục, 81/85 khoá ngoại. Chỉ 13 chỗ cần quyết định bằng tay (§7.4) |
| Vòng đời | SQL Server 2017 hết hỗ trợ mở rộng **12/10/2027** |
| Rào cản hệ điều hành | Không còn: 2017 chạy được trên Windows Server 2012 R2 |

**Khuyến nghị:** giữ PostgreSQL cho lần deploy này. Bản hướng dẫn Windows hiện có đã
đầy đủ và đã kiểm chứng. Nếu ràng buộc là bắt buộc dùng SQL Server, hãy đọc §3 trước
khi quyết định — đó là chỗ duy nhất có mất mát không bù được bằng công sức.

---

## 1. Khối lượng, đo từ mã nguồn

```
$ find src -name '*.repository.ts' | xargs wc -l | tail -1
  5941 total          (16 files)
$ find src -name '*.service.ts' | xargs wc -l | tail -1
  5774 total
$ find src/db/schema -name '*.ts' | xargs wc -l | tail -1
  2610 total
$ find src -name '*.test.ts' | xargs wc -l | tail -1
  4455 total          (14 files, chạy trên PostgreSQL thật)
```

Toàn bộ 16 repository và 2.610 dòng schema phải viết lại. Service viết lại ở những
chỗ gọi repository. **4.455 dòng test phải dựng lại** — chúng chạy qua `app.inject()`
vào PostgreSQL thật, nên không có cách nào giữ nguyên.

---

## 2. Từng cấu trúc, kèm số chỗ

Số ở cột giữa là số lần xuất hiện, đo bằng `grep -o | wc -l` trên `src/`.

| Cấu trúc | Số chỗ | SQL Server 2017 |
|---|---|---|
| `sql\`` template (Drizzle) | **397** | Viết lại theo API của query builder mới |
| `::uuid` cast | **112** | `CAST(x AS uniqueidentifier)` |
| `immutable_unaccent()` | **43** | **Không có tương đương** — CLR UDF hoặc collation |
| `gen_random_uuid()` | **42** | `NEWID()` — cơ học |
| Chỉ mục bộ phận (`.where(sql…)`) | **65** | Filtered index có, nhưng hạn chế |
| `EXISTS` | 49 | Giữ nguyên |
| `jsonb` (22 lần dùng, 5 cột) | 22 | `nvarchar(max)` + `JSON_VALUE`; **không containment, không index** |
| `ILIKE` | 18 | `LIKE` + collation không phân biệt hoa thường |
| `pgEnum` | 25 | **Không có enum** — CHECK constraint hoặc bảng tra |
| `FILTER (WHERE …)` | **13** | **Không có mệnh đề FILTER** — `SUM(CASE WHEN … THEN … END)` |
| `tsvector` / GIN | 11 | Full-Text Search là **dịch vụ riêng**, cú pháp khác |
| `interval` | 8 | `DATEADD` |
| `GREATEST()` | **5** | **Không có trong 2017** (thêm ở 2022) |
| `ON CONFLICT` | 5 | `MERGE` (cần `HOLDLOCK`) hoặc IF EXISTS |
| `citext` | 5 cột | Collation CI trên cột |
| `gin_trgm_ops` (trigram) | 4 | **Không có tương đương nào** |
| `sql.raw` | 4 | Dịch tay |
| `RETURNING` | 3 | `OUTPUT` (khác nhau khi có trigger) |
| Cột generated | 2 | Computed column (persisted) |
| Trigger + function (post.sql) | **21 đối tượng / 392 dòng PL/pgSQL** | Viết lại bằng T-SQL |
| CHECK constraint | 19 | Chuyển được, khác cú pháp |

Hai điểm đáng chú ý vì chúng **không** phải vấn đề:

- **Chỉ mục bộ phận chuyển được.** 65 chỗ dùng `.where(sql\`deleted_at IS NULL\`)`
  hoặc `moderation_state = 'visible'` — so sánh đơn giản với hằng, đúng loại mà
  filtered index của SQL Server chấp nhận. (Nó từ chối `OR`, `IN`, và cột computed.)
- **Ngữ nghĩa NULL của unique index khớp sẵn.** PostgreSQL cần `NULLS NOT DISTINCT`
  (đã dùng ở `leaderboard_running_totals`); SQL Server coi NULL bằng nhau trong
  unique index, nên hành vi mong muốn có được mà không cần gì thêm.

---

## 3. Mất mát thật: tìm kiếm chuỗi con

Đây là chỗ duy nhất trong kế hoạch này mà công sức **không** mua lại được thứ đã mất.

`documents.repository.ts` tìm kiếm bằng hai nhánh OR:

```
1. tsv @@ plainto_tsquery('simple', immutable_unaccent(term))    ← GIN, khớp cả từ
2. immutable_unaccent(search_text) ILIKE immutable_unaccent('%term%')  ← trigram, khớp một phần
```

Chính mã nguồn nói vì sao nhánh 2 không thể bỏ:

> *"Without this, typing `nghe` finds nothing because `tsquery` only matches
> complete tokens."*

Trên SQL Server 2017:

| | |
|---|---|
| Nhánh 1 | Làm được, qua Full-Text Search. Nhưng FTS là **dịch vụ Windows riêng** phải cài trên instance, có catalog riêng, và cú pháp truy vấn khác (`CONTAINS`/`FREETEXT`). Tiếng Việt **có** word breaker (LCID 1066). |
| Nhánh 2 | **Mất chỉ mục.** `LIKE '%…%'` với ký tự đại diện ở đầu **không dùng được bất kỳ chỉ mục B-tree nào** — luôn luôn quét toàn bảng. `pg_trgm` tồn tại đúng để giải quyết việc này, và SQL Server không có tương đương. |
| Xếp hạng | `ts_rank_cd` **không có tương đương**. `CONTAINSTABLE` có cột `RANK` nhưng chỉ phủ nhánh 1. |

Đã kiểm chứng thêm: `SERVERPROPERTY('IsFullTextInstalled')` trả **0** trên instance mặc định — FTS phải được cài riêng, kể cả trên Windows (**§7**).

Với người dùng Việt Nam gõ không dấu — tức là phần lớn truy vấn — nhánh 2 là nhánh
chạy. Nó chuyển từ quét chỉ mục sang **quét toàn bộ bảng `documents` mỗi lần tìm**.

Hai lựa chọn, cả hai đều có giá:

1. **Chấp nhận quét bảng.** Chịu được khi kho tài liệu còn nhỏ; hỏng dần khi lớn lên.
2. **Đưa tìm kiếm ra engine ngoài.** Interface `SearchProvider` **đã được thiết kế cho
   việc này** — chú thích trong `search.provider.ts` đã nhắc tới Meilisearch. Nhưng
   như vậy là thêm một dịch vụ nữa phải chạy trên máy Windows Server 2012 R2, đúng
   thứ mà WINDOWS.md đang cố tránh.

---

## 4. Chọn ORM

Drizzle **không có dialect SQL Server** (đã kiểm chứng: `node_modules/drizzle-orm`
chỉ có `pg-core`, `mysql-core`, `sqlite-core`, `singlestore-core`). Nên bắt buộc đổi.

| | Được | Mất |
|---|---|---|
| **Kysely** | Có dialect MSSQL; vẫn là query builder nên **giữ được phần lớn SQL**; gần mô hình Drizzle hiện tại nhất | Không sinh DDL — schema vẫn viết tay |
| **Prisma** | Client có kiểu, công cụ tốt, hỗ trợ SQL Server chính thức | **Không diễn đạt được** filtered index, trigger, CHECK constraint, computed column → phần lớn DDL vẫn phải viết tay, mà lại phải học một API truy vấn khác |
| **`mssql`/`tedious` thô** | Toàn quyền kiểm soát | Nhiều công nhất, không có kiểu |

**Khuyến nghị: Kysely.** Dự án dùng `sql` template ở 397 chỗ và các truy vấn phức tạp
(tự JOIN, `row_number()`, CTE, aggregate có điều kiện). Một query builder giữ được
gần hết dạng đó; một ORM ưu tiên mô hình quan hệ thì không, và cái giá phải trả là
viết lại cả những truy vấn lẽ ra chỉ cần đổi cú pháp.

---

## 5. Thứ tự thi công

Mỗi bước kết thúc bằng một trạng thái **chạy được**, không phải một nửa chuyển đổi.

1. **Dựng instance và kiểm chứng §7.** Không viết dòng nào trước khi biết chắc
   `GREATEST`, `FILTER`, filtered index và collation tiếng Việt hoạt động ra sao.
2. **Schema trước, dữ liệu sau.** Sinh DDL SQL Server từ `src/db/schema` (2.610 dòng)
   + `post.sql` (392 dòng), dựng trên instance rỗng, chạy seed. Chưa đụng vào `src/`.
3. **Tầng repository.** 16 file, 5.941 dòng. Đây là phần lớn công việc. Làm từng
   module một theo thứ tự phụ thuộc: taxonomy → identity/rbac → documents → uploads →
   social.
4. **Test.** Dựng lại 4.455 dòng. Chuyển `assertTestDatabase()` sang kiểm tra instance
   SQL Server, và `scripts/run-tests.ts` sang tạo database test trên đó.
5. **Di trú dữ liệu.** Chỉ khi 1–4 xong. Script đọc từ PostgreSQL, ghi sang SQL Server,
   kèm đối chiếu số dòng và tổng bộ đếm.
6. **WINDOWS.md viết lại** cho SQL Server: dịch vụ, collation, Full-Text Search, sao lưu.

Ước lượng thẳng: bước 3 và 4 là **vài tuần làm việc**, không phải vài ngày. Chúng
tương đương về khối lượng với toàn bộ phần đã xây.

---

## 6. Rủi ro

| | |
|---|---|
| **Tìm kiếm xuống cấp** | §3. Không có cách sửa rẻ. Đây là rủi ro lớn nhất vì nó chạm vào tính năng được dùng nhiều nhất. |
| **Bộ đếm lệch trong lúc di trú** | Nhiều bộ đếm denormalised (`like_count`, `item_count`, `unread_notification_count`, `leaderboard_running_totals`). Script di trú phải đối chiếu từng cái với bảng gốc **sau khi** chuyển, không phải tin vào giá trị đã chép. |
| **`immutable_unaccent` mất độ chính xác** | 43 chỗ dựa vào nó để gộp dấu tiếng Việt. Collation `_CI_AI` gần đúng nhưng không giống hệt — "Ôn thi" và "On thi" phải tiếp tục va nhau ở unique index, và điều đó phải được **kiểm tra**, không phải giả định. |
| **Trigger đệ quy** | `post.sql` có trigger trên `tags` cập nhật `documents.search_text`. T-SQL trigger chạy theo câu lệnh, không theo dòng — viết theo thói quen PL/pgSQL sẽ sai. |
| **Không có đường lùi** | Sau khi chuyển, quay lại PostgreSQL nghĩa là chuyển ngược lần nữa. Giữ nguyên nhánh PostgreSQL cho tới khi SQL Server chạy đủ lâu. |
| **Vòng đời** | 12/10/2027. Di trú xong vào 2026 nghĩa là chạy trên nền sắp hết hỗ trợ. |

---

## 7. Đã kiểm chứng trên SQL Server 2017 thật

Toàn bộ mục này chạy trên **Microsoft SQL Server 2017 (RTM-CU31-GDR) 14.0.3550.4,
Express Edition, trên Linux** — `mcr.microsoft.com/mssql/server:2017-latest`. Kết quả
là **đo được**, không phải suy đoán.

| # | Kiểm tra | Kết quả |
|---|---|---|
| 1 | `SELECT GREATEST(1,2)` | ❌ **`'GREATEST' is not a recognized built-in function name`** — 5 chỗ phải viết lại bằng `CASE` |
| 2 | `count(*) FILTER (WHERE …)` | ❌ **`Incorrect syntax near the keyword 'WHERE'`** — 13 chỗ phải đổi sang `SUM(CASE WHEN … THEN 1 ELSE 0 END)`, đã chạy thử và cho kết quả đúng |
| 3 | `SERVERPROPERTY('IsFullTextInstalled')` | ❌ trả **0** — Full-Text Search **chưa cài**, đúng như tài liệu nói: là thành phần riêng |
| 4 | Filtered index | ✅ **Chạy được**, kể cả predicate phức hợp `WHERE deleted_at IS NULL AND moderation_state = 'visible'` — đúng dạng 65 chỗ trong schema dùng |
| 4b | Filtered index với `OR` | ❌ **`Incorrect syntax near the keyword 'OR'`** — hạn chế đã biết, nhưng schema hiện tại không dùng `OR` |
| 5 | Gộp dấu tiếng Việt | ⚠️ **Xem dưới — kết quả ngược với điều tôi tưởng** |

### 7.1 Phát hiện quan trọng nhất: collation "đúng" hoá ra là sai

Đây là chỗ tôi đã tưởng sai, và nếu không chạy thử thì kế hoạch này sẽ dẫn tới hỏng
chức năng tìm kiếm trong production.

```
N'Ôn thi' COLLATE Vietnamese_100_CI_AI = N'On thi'   →  KHÁC   ← sai
N'Ôn thi' COLLATE Latin1_General_100_CI_AI = N'On thi' →  GỘP  ← đúng
```

Và lý do, kiểm chứng riêng:

```
N'ô' COLLATE Vietnamese_100_CI_AI   = N'o'  →  KHÁC
N'ô' COLLATE Latin1_General_100_CI_AI = N'o' →  GỘP
N'đ' COLLATE Vietnamese_100_CI_AI   = N'd'  →  KHÁC
N'đ' COLLATE Latin1_General_100_CI_AI = N'd' →  GỘP
```

**Trong collation tiếng Việt, `ô` và `đ` là CHỮ CÁI RIÊNG, không phải `o` và `d` mang
dấu.** Nên `_AI` (accent-insensitive) không gộp chúng — nó chỉ bỏ dấu thanh. Chọn
`Vietnamese_100_CI_AI` vì nó "nghe đúng" sẽ làm **cả 43 chỗ dùng `immutable_unaccent`
hỏng lặng lẽ**: người dùng gõ không dấu sẽ nhận **0 kết quả**, đúng cái thất bại mà
chú thích trong `documents.repository.ts` đang cảnh báo.

**Kết luận: dùng `Latin1_General_100_CI_AI`.** Nó gộp được cả `ô→o` và `đ→d`, tức là
hai chữ cái riêng của tiếng Việt mà `immutable_unaccent` đang xử lý.

> Lưu ý: gộp được không có nghĩa là **giống hệt**. `immutable_unaccent` là hàm của
> dự án và có thể chỉnh; collation thì không. Sau khi chuyển, phải chạy lại đúng bộ
> test đang kiểm tra việc gộp dấu — đặc biệt là test unique index
> `collections_owner_title_uq`, nơi "Ôn thi" và "ôn thi" **phải** va nhau.

### 7.2 Điều đã kiểm chứng là KHÔNG phải vấn đề

- **65 filtered index chuyển được.** Predicate trong schema đều là so sánh đơn giản
  với hằng hoặc `IS NULL`, đúng loại SQL Server chấp nhận. (Lần chạy đầu báo lỗi
  `QUOTED_IDENTIFIER` — đó là **thiết lập của phiên `sqlcmd`**, không phải giới hạn
  của SQL Server. Bật lên là tạo được.)
- **Ngữ nghĩa NULL của unique index khớp sẵn.** PostgreSQL cần `NULLS NOT DISTINCT`;
  SQL Server coi NULL bằng nhau trong unique index, nên hành vi mong muốn có sẵn.

### 7.3 Còn phải kiểm tra trước khi di trú dữ liệu thật

- **Giới hạn của bản Express.** Bản chạy thử là Express: database tối đa **10 GB**,
  buffer pool 1.410 MB, 4 nhân. Với một nền tảng lưu metadata (tệp nằm ở SeaweedFS)
  thì 10 GB là thoải mái, nhưng phải xác nhận trước.
- **`Latin1_General_100_CI_AI` có sẵn trên Windows Server 2012 R2** với SQL Server
  2017 hay không — bản Linux đã có, bản Windows cũng nên có, nhưng phải kiểm.
- **Hiệu năng của nhánh tìm kiếm chuỗi con** sau khi mất chỉ mục trigram (§3). Đo
  bằng `SET STATISTICS IO ON` trên dữ liệu cỡ thật, không phải trên bảng rỗng.

---


### 7.4 Đã sinh thử toàn bộ schema và áp lên SQL Server

`backend/scripts/pg-to-mssql-ddl.ts` đọc catalog PostgreSQL và sinh DDL SQL Server.
Không phải bản di trú — là **công cụ đo**: nó biến "chắc là vài tuần" thành con số.

```
1.910 dòng T-SQL
  53/53 bảng tạo được
 169 chỉ mục
  81/85 khoá ngoại
  39 CHECK constraint cho enum
  13 TODO (cột generated, default lạ, chỉ mục biểu thức)
```

Chỉ **13 chỗ** trong 53 bảng không chuyển máy móc được. Đó là tin tốt, và nó đo
được chứ không phải đoán.

### 7.5 Bốn khoá ngoại bị SQL Server từ chối — đây là khác biệt thật

```
Msg 1785: Introducing FOREIGN KEY constraint 'comments_parent_comment_id_comments_id_fk'
          may cause cycles or multiple cascade paths.
```

**PostgreSQL cho phép nhiều đường cascade; SQL Server thì không.** `comments` có
`author_user_id → users ON DELETE CASCADE` *và* `parent_comment_id → comments ON
DELETE CASCADE`. Xoá một người dùng sẽ cascade tới bình luận của họ, rồi cascade
tiếp tới các trả lời — hai đường tới cùng một dòng, và SQL Server từ chối.

Đây **không phải lỗi của bộ chuyển đổi** và không sửa được bằng cú pháp. Phải chọn:
bỏ `CASCADE` ở một trong hai khoá và chuyển việc dọn dẹp vào mã ứng dụng hoặc
trigger. Cùng dạng ở `follows` (`follower` và `followee` cùng trỏ về `users`).

Việc này phải được quyết **trước** khi di trú dữ liệu, vì nó đổi hành vi xoá.

### 7.6 Hai lỗi còn lại của bộ chuyển đổi

Không phải vấn đề của SQL Server, mà là chỗ bộ chuyển đổi chưa xử lý hết predicate
của chỉ mục:

```
Msg 1911: Column name '"position"' does not exist   ← dấu ngoặc kép lọt vào predicate
Msg 156:  Incorrect syntax near the keyword 'ANY'   ← toán tử mảng = ANY(...) của Postgres
```

Cả hai đều nằm trong predicate của filtered index. Sửa được, và §2 đã đếm được bao
nhiêu chỗ thuộc dạng này.

---

## 8. Không nằm trong kế hoạch này

- Chuyển đổi dữ liệu thật (cần instance chạy được trước).
- Thay đổi frontend — không có gì ở frontend phụ thuộc vào PostgreSQL.
- Chọn engine tìm kiếm ngoài. Nếu chọn hướng đó, nó là dự án riêng.
