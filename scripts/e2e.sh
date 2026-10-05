#!/usr/bin/env bash
#
# End-to-end test — the full user journey through the FRONTEND origin.
#
# Deliberately hits :5173 (the Vite dev server), not :4000. That means every
# request travels the same path production uses: frontend origin → API proxy →
# backend. Testing against :4000 directly would skip the proxy entirely and miss
# exactly the class of bug the proxy introduces — dropped Set-Cookie headers,
# mangled query strings, non-streamed bodies.
#
# Covers the acceptance criteria: register, login, browse, search, upload,
# create, preview, download, rate, moderate, sign out.
#
# Usage:  bash scripts/e2e.sh [base-url]
#   default base-url: http://localhost:5173

set -uo pipefail

BASE="${1:-http://localhost:5173}"
API="$BASE/api/v1"

PASS=0
FAIL=0
declare -a FAILURES=()

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

check() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  %s  %s\n' "$(green PASS)" "$name"
    PASS=$((PASS + 1))
  else
    printf '  %s  %s  (expected %s, got %s)\n' "$(red FAIL)" "$name" "$expected" "$actual"
    FAIL=$((FAIL + 1))
    FAILURES+=("$name")
  fi
}

# Extract a cookie value from a saved header dump.
cookie() { grep -i "^set-cookie: $1=" "$2" 2>/dev/null | head -1 | sed -E "s/^[Ss]et-[Cc]ookie: $1=([^;]*).*/\1/" | tr -d '\r'; }

# Pull a field out of a JSON response.
#
# The expression is passed via argv, NOT interpolated into the Python source.
# Interpolating it inside a double-quoted string collapses the single quotes —
# `eval('d'+'['data']['x']')` is a syntax error — and with stderr suppressed the
# failure is silent, so every extraction returns empty and every assertion fails
# for a reason that has nothing to do with the application.
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Clear rate-limit counters so this run is judged on its own traffic rather
# than the previous run's. Several logins happen below; an exhausted limiter
# would otherwise fail unrelated assertions with 429s.
#
# Two separate mechanisms have to be cleared, and only clearing one is worse
# than clearing neither — it looks like the problem is solved. The route plugin
# counts requests (`fastify-rate-limit-*`); the per-account lockout counts
# *failures* under its own namespace (`auth:fail:*`) and survives the first
# reset, so run two fails at login with a 423 while everything else still
# passes.
if command -v docker >/dev/null 2>&1; then
  for pattern in 'fastify-rate-limit-*' 'auth:fail:*'; do
    docker exec -i tailieu-redis redis-cli --scan --pattern "$pattern" 2>/dev/null \
      | xargs -r docker exec -i tailieu-redis redis-cli DEL >/dev/null 2>&1 || true
  done
fi

echo
echo "TAILIEU TTN — end-to-end"
echo "target: $BASE"
echo

# ─── 1. Reachability ────────────────────────────────────────────────────────
echo "1. Kết nối"
check "trang chủ trả về 200" "200" "$(code "$BASE/")"
check "health qua proxy" "200" "$(code "$BASE/api/health")"
check "proxy chuyển tiếp tới API" "7" "$(curl -s "$API/taxonomy/faculties?limit=100" | jget "['meta']['total']")"

# ─── 2. Taxonomy ────────────────────────────────────────────────────────────
echo
echo "2. Taxonomy (dữ liệu 2026)"
TREE=$(curl -s "$API/taxonomy/tree")
check "đủ 7 khoa trong dữ liệu 2026" "yes" \
  "$(echo "$TREE" | python3 -c "
import sys,json
codes={f['code'] for f in json.load(sys.stdin)['data']}
expected={'YD','SP','LLCT','NN','KT','KHTNCN','NNg'}
print('yes' if expected <= codes else 'no: ' + ','.join(sorted(expected-codes)))")"
check "đủ 37 ngành trong dữ liệu 2026" "yes" \
  "$(echo "$TREE" | python3 -c "
import sys,json
codes={p['code'] for f in json.load(sys.stdin)['data'] for p in f['programs']}
expected={'7720101','7720301','7720601','7140201','7140202','7140202JR','7140206',
          '7140217','7310403','7229030','7140205','7229001','7140231','7220201',
          '7310101','7310105','7620115','7340101','7340121','7340201','7340205',
          '7340301','7140209','7140211','7140212','7140213','7140247','7420201',
          '7420201YD','7480201','7540101','7620105','7640101','7620110','7620112',
          '7620205','7850103'}
missing=expected-codes
print('yes' if not missing else 'thiếu: ' + ','.join(sorted(missing)))")"

FACULTY_ID=$(curl -s "$API/taxonomy/faculties?q=C%C3%B4ng%20ngh%E1%BB%87" | jget "['data'][0]['id']")
DOC_TYPE_ID=$(curl -s "$API/taxonomy/document-types?limit=50" | python3 -c "
import sys,json
print(next(t['id'] for t in json.load(sys.stdin)['data'] if t['code']=='lecture'))")
check "lấy được khoa CNTT" "36" "${#FACULTY_ID}"

# ─── 3. Search, tiếng Việt không dấu ─────────────────────────────────────────
echo
echo "3. Tìm kiếm tiếng Việt"
SUGGEST=$(curl -s "$API/search/suggest?q=cong")
check "gợi ý không dấu ra kết quả có dấu" "yes" \
  "$(echo "$SUGGEST" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print('yes' if any('Công nghệ' in s['label'] for s in d) else 'no')")"
check "gợi ý trả về nhiều loại" "yes" \
  "$(echo "$SUGGEST" | python3 -c "
import sys,json
kinds={s['kind'] for s in json.load(sys.stdin)['data']}
print('yes' if 'faculty' in kinds and 'program' in kinds else 'no')")"
check "tìm kiếm rỗng bị từ chối" "422" "$(code "$API/search/suggest?q=")"

# ─── 4. Đăng ký + đăng nhập ─────────────────────────────────────────────────
echo
echo "4. Xác thực"
EMAIL="e2e-$(date +%s)-$RANDOM@tailieu.test"
REG_CODE=$(curl -s -D "$TMP/h-reg" -o "$TMP/b-reg" -w '%{http_code}' -X POST "$API/auth/register" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"MatKhauRatDai2026\",\"displayName\":\"E2E Tester\"}")
check "đăng ký trả 201" "201" "$REG_CODE"
check "đăng ký trùng email bị từ chối" "409" \
  "$(code -X POST "$API/auth/register" -H 'content-type: application/json' \
     -d "{\"email\":\"$EMAIL\",\"password\":\"MatKhauRatDai2026\",\"displayName\":\"Trùng\"}")"

STU_TOKEN=$(jget "['data']['accessToken']" < "$TMP/b-reg")
check "đăng ký trả access token" "yes" "$([ -n "$STU_TOKEN" ] && echo yes || echo no)"
check "cookie làm mới được đặt" "yes" "$([ -n "$(cookie rt "$TMP/h-reg")" ] && echo yes || echo no)"
check "cookie CSRF được đặt" "yes" "$([ -n "$(cookie csrf "$TMP/h-reg")" ] && echo yes || echo no)"
check "cookie CSRF KHÔNG httpOnly" "yes" \
  "$(grep -i '^set-cookie: csrf=' "$TMP/h-reg" | grep -qi 'HttpOnly' && echo no || echo yes)"

curl -s -D "$TMP/h-login" -o "$TMP/b-login" -X POST "$API/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"student@tailieu.local","password":"ChangeMe_Student_2026"}'
STU_TOKEN=$(jget "['data']['accessToken']" < "$TMP/b-login")
CSRF=$(cookie csrf "$TMP/h-login")
RT=$(cookie rt "$TMP/h-login")
AUTH="authorization: Bearer $STU_TOKEN"
COOKIES="cookie: rt=$RT; csrf=$CSRF"
check "đăng nhập sinh viên" "yes" "$([ -n "$STU_TOKEN" ] && echo yes || echo no)"
check "/auth/me trả hồ sơ" "student@tailieu.local" \
  "$(curl -s "$API/auth/me" -H "$AUTH" | jget "['data']['email']")"
check "không token thì 401" "401" "$(code "$API/auth/me")"
check "sai mật khẩu thì 401" "401" \
  "$(code -X POST "$API/auth/login" -H 'content-type: application/json' \
     -d '{"email":"student@tailieu.local","password":"sai-mat-khau"}')"

# ─── 5. Tải lên chia phần ───────────────────────────────────────────────────
echo
echo "5. Tải lên chia phần"
# Tệp PDF hợp lệ, đủ lớn để kiểm tra nhiều phần ở chế độ chunk nhỏ.
python3 - "$TMP/upload.pdf" <<'PY'
import sys, zlib
# A minimal single-page PDF with real content.
body = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj
4 0 obj<</Length 44>>stream
BT /F1 12 Tf 72 720 Td (Bai giang C++) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>
%%EOF
"""
open(sys.argv[1], 'wb').write(body)
PY
SIZE=$(stat -c%s "$TMP/upload.pdf")

INTENT=$(curl -s -X POST "$API/uploads" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"fileName\":\"bai-giang-e2e.pdf\",\"sizeBytes\":$SIZE,\"mimeType\":\"application/pdf\"}")
UPLOAD_ID=$(echo "$INTENT" | jget "['data']['uploadId']")
check "tạo phiên tải lên" "yes" "$([ -n "$UPLOAD_ID" ] && echo yes || echo no)"
check "báo trước số phần" "1" "$(echo "$INTENT" | jget "['data']['totalChunks']")"

CHUNK_RES=$(curl -s -X PUT "$API/uploads/$UPLOAD_ID/chunks/0" -H "$AUTH" \
  -H 'content-type: application/octet-stream' --data-binary "@$TMP/upload.pdf")
check "gửi phần 0 thành công" "1" "$(echo "$CHUNK_RES" | jget "['data']['receivedChunks']")"

DONE=$(curl -s -X POST "$API/uploads/$UPLOAD_ID/complete" -H "$AUTH")
check "ghép tệp thành công" "True" "$(echo "$DONE" | jget "['success']")"
check "nhận dạng đúng PDF" "application/pdf" "$(echo "$DONE" | jget "['data']['detectedMime']")"
check "kích thước khớp" "$SIZE" "$(echo "$DONE" | jget "['data']['sizeBytes']")"

# Tệp giả mạo: byte PNG nhưng đặt tên .pdf
printf '\x89PNG\r\n\x1a\n' > "$TMP/fake.pdf"; head -c 500 /dev/urandom >> "$TMP/fake.pdf"
FSIZE=$(stat -c%s "$TMP/fake.pdf")
FAKE_ID=$(curl -s -X POST "$API/uploads" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"fileName\":\"gia-mao.pdf\",\"sizeBytes\":$FSIZE,\"mimeType\":\"application/pdf\"}" | jget "['data']['uploadId']")
check "tệp giả mạo bị từ chối (415)" "415" \
  "$(code -X PUT "$API/uploads/$FAKE_ID/chunks/0" -H "$AUTH" \
     -H 'content-type: application/octet-stream' --data-binary "@$TMP/fake.pdf")"

# ─── 6. Tạo tài liệu ────────────────────────────────────────────────────────
echo
echo "6. Tài liệu"
DOC=$(curl -s -X POST "$API/documents" -H "$AUTH" -H 'content-type: application/json' -d "{
  \"title\":\"Bài giảng E2E — Lập trình C++\",
  \"description\":\"Tài liệu kiểm thử đầu-cuối\",
  \"documentTypeId\":\"$DOC_TYPE_ID\",
  \"facultyId\":\"$FACULTY_ID\",
  \"visibility\":\"public\",
  \"uploadIds\":[\"$UPLOAD_ID\"],
  \"tags\":[\"C++\",\"Kiểm thử\"],
  \"uploaderConfirmed\":true
}")
DOC_ID=$(echo "$DOC" | jget "['data']['id']")
check "tạo tài liệu" "True" "$(echo "$DOC" | jget "['success']")"
check "trạng thái đã đăng" "published" "$(echo "$DOC" | jget "['data']['status']")"
check "gắn được tệp" "1" "$(echo "$DOC" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']['files']))")"
check "gắn được thẻ" "2" "$(echo "$DOC" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']['tags']))")"
check "quyền của chủ sở hữu" "True" "$(echo "$DOC" | jget "['data']['permissions']['canEdit']")"

check "không rò rỉ khoá lưu trữ" "clean" \
  "$(curl -s "$API/documents/$DOC_ID" -H "$AUTH" | grep -qE 'objectKey|storageKey|"bucket"|contentHash' && echo LEAK || echo clean)"

echo "=== chờ quét virus (nếu đang bật) ==="
# When SCAN_ENABLED is true a file stays pending and is deliberately not
# downloadable until the scanner clears it. Waiting here is the feature
# working, not a flaky test — asserting immediately would only pass with
# scanning switched off, which is not the configuration under test.
SCAN_WAIT=0
until curl -s "$API/documents/$DOC_ID/download" -H "$AUTH" | grep -q '"url"'; do
  SCAN_WAIT=$((SCAN_WAIT + 1))
  if [ "$SCAN_WAIT" -ge 20 ]; then
    echo "  (vẫn chưa sẵn sàng sau 60s — quét có thể đang bật và clamd chậm)"
    break
  fi
  sleep 3
done
[ "$SCAN_WAIT" -gt 0 ] && echo "  tệp sẵn sàng sau ~$((SCAN_WAIT * 3))s"

# ─── 7. Xem trước + tải xuống ───────────────────────────────────────────────
echo
echo "7. Xem trước và tải xuống"
PREVIEW=$(curl -s "$API/documents/$DOC_ID/preview" -H "$AUTH")
check "xem trước nhận dạng PDF" "pdf" "$(echo "$PREVIEW" | jget "['data']['kind']")"
PREVIEW_URL=$(echo "$PREVIEW" | jget "['data']['url']")
check "xem trước có URL" "yes" "$([ -n "$PREVIEW_URL" ] && echo yes || echo no)"

DL=$(curl -s "$API/documents/$DOC_ID/download" -H "$AUTH")
DL_URL=$(echo "$DL" | jget "['data']['url']")
check "tải xuống trả URL có chữ ký" "yes" "$([ -n "$DL_URL" ] && echo yes || echo no)"
check "URL hết hạn sau 120s" "120" "$(echo "$DL" | jget "['data']['expiresInSeconds']")"

curl -s -o "$TMP/downloaded.pdf" "$DL_URL"
check "nội dung tải về khớp bản gốc" "$(sha256sum < "$TMP/upload.pdf" | cut -d' ' -f1)" \
  "$(sha256sum < "$TMP/downloaded.pdf" | cut -d' ' -f1)"

# `>= 1`, not `== 1`. Minting a signed URL records a download event even if the
# transfer never starts — a deliberate choice, since an authorised-but-abandoned
# download is still intent worth counting — and the readiness poll above mints
# the URL several times. Asserting an exact count would be asserting the poll
# ran once, which is not what this checks.
DOWNLOADS=$(curl -s "$API/documents/$DOC_ID" -H "$AUTH" | jget "['data']['stats']['downloads']")
check "lượt tải đã tăng" "yes" "$([ "${DOWNLOADS:-0}" -ge 1 ] && echo yes || echo no)"

# ─── 8. Phân quyền ──────────────────────────────────────────────────────────
echo
echo "8. Phân quyền"
MOD_TOKEN=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"moderator@tailieu.local","password":"ChangeMe_Mod_2026"}' | jget "['data']['accessToken']")
ADMIN_TOKEN=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"admin@tailieu.local","password":"ChangeMe_Admin_2026"}' | jget "['data']['accessToken']")

check "sinh viên không tạo được khoa" "403" \
  "$(code -X POST "$API/taxonomy/faculties" -H "$AUTH" -H 'content-type: application/json' \
     -d '{"code":"E2E1","name":"Khoa test"}')"
check "kiểm duyệt viên không tạo được khoa" "403" \
  "$(code -X POST "$API/taxonomy/faculties" -H "authorization: Bearer $MOD_TOKEN" \
     -H 'content-type: application/json' -d '{"code":"E2E2","name":"Khoa test"}')"
E2E_FAC_CODE="E2E$RANDOM"
E2E_FAC=$(curl -s -D "$TMP/h-fac" -X POST "$API/taxonomy/faculties" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d "{\"code\":\"$E2E_FAC_CODE\",\"name\":\"Khoa E2E\"}")
E2E_FAC_ID=$(echo "$E2E_FAC" | jget "['data']['id']")
check "quản trị tạo được khoa" "yes" "$([ -n "$E2E_FAC_ID" ] && echo yes || echo no)"

check "sinh viên không kiểm duyệt được" "403" \
  "$(code -X POST "$API/documents/$DOC_ID/moderate" -H "$AUTH" \
     -H 'content-type: application/json' -d '{"action":"archive"}')"

# ─── 9. Đánh giá ────────────────────────────────────────────────────────────
echo
echo "9. Đánh giá"
check "không tự đánh giá được" "403" \
  "$(code -X POST "$API/documents/$DOC_ID/ratings" -H "$AUTH" \
     -H 'content-type: application/json' -d '{"rating":5}')"
check "kiểm duyệt viên đánh giá được" "4" \
  "$(curl -s -X POST "$API/documents/$DOC_ID/ratings" -H "authorization: Bearer $MOD_TOKEN" \
     -H 'content-type: application/json' -d '{"rating":4,"review":"Hữu ích"}' | jget "['data']['ratingAverage']")"
check "đổi đánh giá không tăng số lượt" "1" \
  "$(curl -s -X POST "$API/documents/$DOC_ID/ratings" -H "authorization: Bearer $MOD_TOKEN" \
     -H 'content-type: application/json' -d '{"rating":2}' | jget "['data']['ratingCount']")"

# ─── 10. Cộng đồng: bài đăng và luồng bình luận ──────────────────────────────
echo
echo "10. Cộng đồng"
FRESH=$(curl -s -X POST "$API/auth/login" -H 'content-type: application/json' \
  -d '{"email":"student@tailieu.local","password":"ChangeMe_Student_2026"}' | jget "['data']['accessToken']")
FAUTH="authorization: Bearer $FRESH"
FJSON='content-type: application/json'

POST_ID=$(curl -s -X POST "$API/posts" -H "$FAUTH" -H "$FJSON" \
  -d '{"body":"E2E- bài kiểm thử luồng bình luận","visibility":"public","postKind":"status","tags":[]}' \
  | jget "['data']['id']")
check "đăng được bài" "yes" "$([ -n "$POST_ID" ] && echo yes || echo no)"

ROOT_ID=$(curl -s -X POST "$API/comments" -H "$FAUTH" -H "$FJSON" \
  -d "{\"targetType\":\"post\",\"targetId\":\"$POST_ID\",\"body\":\"E2E- gốc\"}" \
  | jget "['data']['id']")
REPLY_ID=$(curl -s -X POST "$API/comments" -H "$FAUTH" -H "$FJSON" \
  -d "{\"targetType\":\"post\",\"targetId\":\"$POST_ID\",\"body\":\"E2E- trả lời\",\"parentCommentId\":\"$ROOT_ID\"}" \
  | jget "['data']['id']")

THREAD=$(curl -s "$API/comments?targetType=post&targetId=$POST_ID&limit=50")
check "luồng có 1 bình luận gốc" "1" "$(echo "$THREAD" | jget "['meta']['total']")"
check "trả lời nằm dưới gốc" "E2E- trả lời" \
  "$(echo "$THREAD" | jget "['data'][0]['replies'][0]['body']")"
check "bài đếm đúng 2 bình luận" "2" \
  "$(curl -s "$API/posts/$POST_ID" | jget "['data']['stats']['comments']")"

# The regression this section exists for. Deleting a top-level comment used to
# take its whole subtree with it: the thread came back empty while the post went
# on advertising the full count, so the page read "2 bình luận" above nothing.
# A live reply must survive its parent's removal.
check "xoá được bình luận gốc" "200" "$(code -X DELETE "$API/comments/$ROOT_ID" -H "$FAUTH")"

AFTER=$(curl -s "$API/comments?targetType=post&targetId=$POST_ID&limit=50")
check "gốc đã xoá vẫn giữ chỗ trong luồng" "1" "$(echo "$AFTER" | jget "['meta']['total']")"
check "gốc đã xoá được đánh dấu" "True" "$(echo "$AFTER" | jget "['data'][0]['deleted']")"
check "thân bình luận đã xoá bị giữ kín" "" "$(echo "$AFTER" | jget "['data'][0]['body']")"
check "tên tác giả đã xoá bị giữ kín" "" "$(echo "$AFTER" | jget "['data'][0]['author']['id']")"
check "trả lời còn sống vẫn hiển thị" "E2E- trả lời" \
  "$(echo "$AFTER" | jget "['data'][0]['replies'][0]['body']")"
check "không trả lời được vào bình luận đã xoá" "404" \
  "$(code -X POST "$API/comments" -H "$FAUTH" -H "$FJSON" \
     -d "{\"targetType\":\"post\",\"targetId\":\"$POST_ID\",\"body\":\"mồ côi\",\"parentCommentId\":\"$ROOT_ID\"}")"

# A count the thread cannot account for is the symptom of the bug above, so the
# two are asserted against each other rather than each against a constant.
SLOTS=$(echo "$AFTER" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
print(sum(1 + len(c.get('replies') or []) for c in d))
")
check "số đếm khớp số chỗ trong luồng" "2" "$SLOTS"

check "thích được bài" "True" \
  "$(curl -s -X PUT "$API/likes/post/$POST_ID" -H "$FAUTH" -H "$FJSON" \
     -d '{"liked":true}' | jget "['data']['liked']")"
check "bỏ thích được bài" "False" \
  "$(curl -s -X PUT "$API/likes/post/$POST_ID" -H "$FAUTH" -H "$FJSON" \
     -d '{"liked":false}' | jget "['data']['liked']")"

# ─── 11. Bộ sưu tập ─────────────────────────────────────────────────────────
echo
echo "11. Bộ sưu tập"

# The leak this section exists for. A collection is a list of *pointers*, and
# the pointers are what leak: a public collection holding a post that later
# becomes private must stop showing it, and the count above the list has to
# move with it. Asserting only on the item list would miss the count, and
# asserting only on the count would miss a title in the response body — so both
# are checked, and the body is checked as a raw string.
COL_POST=$(curl -s -X POST "$API/posts" -H "$FAUTH" -H "$FJSON" \
  -d '{"body":"E2E- bài trong bộ sưu tập","visibility":"public","postKind":"status","tags":[]}' \
  | jget "['data']['id']")
check "tạo bài để lưu vào bộ sưu tập" "yes" "$([ -n "$COL_POST" ] && echo yes || echo no)"

COL_ID=$(curl -s -X POST "$API/collections" -H "$FAUTH" -H "$FJSON" \
  -d '{"title":"E2E- bộ sưu tập kiểm thử","visibility":"public"}' | jget "['data']['id']")
check "tạo được bộ sưu tập" "yes" "$([ -n "$COL_ID" ] && echo yes || echo no)"

check "trùng tên khác hoa bị từ chối" "409" \
  "$(code -X POST "$API/collections" -H "$FAUTH" -H "$FJSON" \
     -d '{"title":"E2E- BỘ SƯU TẬP KIỂM THỬ","visibility":"public"}')"

check "thêm được mục vào bộ sưu tập" "201" \
  "$(code -X POST "$API/collections/$COL_ID/items" -H "$FAUTH" -H "$FJSON" \
     -d "{\"targetType\":\"post\",\"targetId\":\"$COL_POST\"}")"

ANON_COL=$(curl -s "$API/collections/$COL_ID")
check "khách ẩn danh thấy đúng 1 mục" "1" \
  "$(echo "$ANON_COL" | jget "['data']['itemCount']")"
check "số đếm khớp số mục hiển thị" "1" \
  "$(echo "$ANON_COL" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']['items']))")"

# Hide the post. Nothing about the collection changed — but everything the
# reader is shown must.
curl -s -X PATCH "$API/posts/$COL_POST" -H "$FAUTH" -H "$FJSON" \
  -d '{"visibility":"private"}' -o /dev/null

HIDDEN=$(curl -s "$API/collections/$COL_ID")
check "bài riêng tư biến mất khỏi bộ sưu tập công khai" "0" \
  "$(echo "$HIDDEN" | jget "['data']['itemCount']")"
check "không rò rỉ tiêu đề qua thân phản hồi" "clean" \
  "$(echo "$HIDDEN" | grep -q 'E2E- bài trong bộ sưu tập' && echo leak || echo clean)"
# The owner keeps seeing what they always could. If this were 0 the fix would
# have been "hide it from everyone", which is a different bug.
check "chủ sở hữu vẫn thấy mục của mình" "1" \
  "$(curl -s "$API/collections/$COL_ID" -H "$FAUTH" | jget "['data']['itemCount']")"

check "không tạo được bộ sưu tập khi chưa đăng nhập" "401" \
  "$(code -X POST "$API/collections" -H "$FJSON" \
     -d '{"title":"E2E- không đăng nhập"}')"

# A private collection must answer 404 to someone who cannot see it, never 403.
# A 403 would confirm the id exists, which turns the uuid space into an oracle.
COL_PRIV=$(curl -s -X POST "$API/collections" -H "$FAUTH" -H "$FJSON" \
  -d '{"title":"E2E- bộ sưu tập riêng tư"}' | jget "['data']['id']")
check "tạo được bộ sưu tập riêng tư" "private" \
  "$(curl -s "$API/collections/$COL_PRIV" -H "$FAUTH" | jget "['data']['visibility']")"
check "khách ẩn danh nhận 404 cho bộ sưu tập riêng tư" "404" \
  "$(code "$API/collections/$COL_PRIV")"

# ─── 12. CSRF ───────────────────────────────────────────────────────────────
echo
echo "12. Bảo vệ CSRF"
check "thiếu header CSRF thì 403" "403" \
  "$(code -X POST "$API/auth/logout" -H "$AUTH" -H "$COOKIES")"
check "sai header CSRF thì 403" "403" \
  "$(code -X POST "$API/auth/logout" -H "$AUTH" -H "$COOKIES" -H 'x-csrf-token: sai')"
check "đúng header CSRF thì 200" "200" \
  "$(code -X POST "$API/auth/logout" -H "$AUTH" -H "$COOKIES" -H "x-csrf-token: $CSRF")"
check "token chết sau khi đăng xuất" "401" "$(code "$API/auth/me" -H "$AUTH")"

# ─── 12. Xoá dữ liệu kiểm thử ───────────────────────────────────────────────
echo
echo "13. Dọn dẹp"
check "xoá được tài liệu của mình" "200" \
  "$(code -X DELETE "$API/documents/$DOC_ID" -H "authorization: Bearer $FRESH")"
check "tài liệu đã xoá thì 404" "404" "$(code "$API/documents/$DOC_ID" -H "authorization: Bearer $FRESH")"

# Leave no trace. A test that creates rows and abandons them makes the next
# run's assertions drift, and the drift looks like a product bug.
#
# The post goes first: comments are polymorphic, so there is no foreign key from
# a comment to its post and deleting the post would strand them.
if [ -n "${POST_ID:-}" ]; then
  check "dọn bài kiểm thử" "200" "$(code -X DELETE "$API/posts/$POST_ID" -H "$FAUTH")"
fi

if [ -n "${COL_ID:-}" ]; then
  check "dọn bộ sưu tập" "200" "$(code -X DELETE "$API/collections/$COL_ID" -H "$FAUTH")"
fi

if [ -n "${COL_PRIV:-}" ]; then
  check "dọn bộ sưu tập riêng tư" "200" "$(code -X DELETE "$API/collections/$COL_PRIV" -H "$FAUTH")"
fi

if [ -n "${COL_POST:-}" ]; then
  check "dọn bài trong bộ sưu tập" "200" "$(code -X DELETE "$API/posts/$COL_POST" -H "$FAUTH")"
fi

if [ -n "${E2E_FAC_ID:-}" ]; then
  check "dọn khoa kiểm thử" "200" \
    "$(code -X DELETE "$API/taxonomy/faculties/$E2E_FAC_ID" -H "authorization: Bearer $ADMIN_TOKEN")"
fi

# ─── Kết quả ────────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf '%s  %d/%d kiểm tra đạt\n' "$(green 'TẤT CẢ ĐẠT')" "$PASS" "$TOTAL"
else
  printf '%s  %d/%d đạt, %d lỗi:\n' "$(red 'CÓ LỖI')" "$PASS" "$TOTAL" "$FAIL"
  for f in "${FAILURES[@]}"; do printf '     - %s\n' "$f"; done
fi
echo
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
