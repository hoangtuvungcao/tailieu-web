#!/usr/bin/env bash
#
# Script to Audit & Purge infringing, copyrighted, or sensitive documents
#
# Usage:
#   bash scripts/purge-infringing-content.sh audit   # Chỉ rà soát và in danh sách
#   bash scripts/purge-infringing-content.sh purge   # Thực hiện ẩn/lưu trữ dữ liệu vi phạm
#

set -euo pipefail

ACTION="${1:-audit}"

# Load .env if present
if [ -f ".env" ]; then
  export $(grep -E '^(DATABASE_URL|POSTGRES_USER|POSTGRES_DB)=' .env | xargs)
fi

DB_USER="${POSTGRES_USER:-tailieu}"
DB_NAME="${POSTGRES_DB:-tailieu}"

run_sql() {
  local query="$1"
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q 'postgres'; then
    docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c "$query"
  elif [ -n "${DATABASE_URL:-}" ] && command -v psql >/dev/null 2>&1; then
    psql "$DATABASE_URL" -c "$query"
  else
    echo "⚠️  Không tìm thấy Docker container 'postgres' hoặc psql."
    return 1
  fi
}

case "$ACTION" in
  audit)
    echo "🔍 Đang rà soát các tài liệu có dấu hiệu vi phạm hoặc gắn với thương hiệu trường cũ..."
    run_sql "
      SELECT d.id, d.title, d.status, dt.name as category, d.deleted_at
      FROM documents d
      JOIN document_types dt ON d.document_type_id = dt.id
      WHERE (
        d.title ILIKE '%Tây Nguyên%'
        OR d.title ILIKE '%TTN%'
        OR d.title ILIKE '%ĐHTN%'
        OR dt.code = 'textbook'
      )
      ORDER BY d.created_at DESC;
    "
    ;;
  purge)
    echo "🧹 Đang tiến hành ẩn và lưu trữ (soft-delete) các tài liệu vi phạm..."
    run_sql "
      UPDATE documents
      SET deleted_at = NOW(), status = 'archived'
      WHERE deleted_at IS NULL
        AND (
          title ILIKE '%Tây Nguyên%'
          OR title ILIKE '%TTN%'
          OR title ILIKE '%ĐHTN%'
          OR document_type_id IN (SELECT id FROM document_types WHERE code = 'textbook')
        );
    "
    echo "✅ Đã dọn dẹp và ẩn toàn bộ tài liệu vi phạm khỏi hệ thống thành công!"
    ;;
  *)
    echo "Cách dùng: bash scripts/purge-infringing-content.sh [audit|purge]"
    exit 1
    ;;
esac
