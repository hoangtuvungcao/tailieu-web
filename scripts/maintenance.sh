#!/usr/bin/env bash
#
# Helper script to toggle Maintenance Mode in PostgreSQL database
#
# Usage:
#   bash scripts/maintenance.sh on      # Bật chế độ bảo trì
#   bash scripts/maintenance.sh off     # Tắt chế độ bảo trì
#   bash scripts/maintenance.sh status  # Kiểm tra trạng thái
#

set -euo pipefail

ACTION="${1:-status}"

# Load .env if present
if [ -f ".env" ]; then
  # Export DATABASE_URL and Postgres credentials if available
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
    echo "⚠️  Không tìm thấy Docker container 'postgres' hoặc công cụ psql cục bộ."
    echo "👉 Hãy chạy câu lệnh SQL này trong database của bạn:"
    echo "   $query"
    return 1
  fi
}

case "$ACTION" in
  on|ON|enable)
    echo "🔧 Đang BẬT chế độ bảo trì (Maintenance Mode = true)..."
    run_sql "UPDATE settings SET value = 'true'::jsonb WHERE key = 'maintenance_mode';"
    echo "✅ Đã BẬT bảo trì thành công! API sẽ trả về 503 cho toàn bộ người dùng thông thường."
    ;;
  off|OFF|disable)
    echo "🚀 Đang TẮT chế độ bảo trì (Maintenance Mode = false)..."
    run_sql "UPDATE settings SET value = 'false'::jsonb WHERE key = 'maintenance_mode';"
    echo "✅ Đã TẮT bảo trì thành công! Hệ thống mở lại bình thường."
    ;;
  status)
    echo "🔍 Kiểm tra trạng thái bảo trì hiện tại:"
    run_sql "SELECT key, value, updated_at FROM settings WHERE key = 'maintenance_mode';"
    ;;
  *)
    echo "Cách dùng: bash scripts/maintenance.sh [on|off|status]"
    exit 1
    ;;
esac
