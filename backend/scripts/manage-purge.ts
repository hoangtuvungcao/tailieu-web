import pg from 'pg';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DEFAULT_URL =
  process.env.DATABASE_URL ?? 'postgres://tailieu:devpassword@127.0.0.1:5432/tailieu';

const mode = (process.argv[2] ?? 'audit').toLowerCase();

async function getWorkingPool(): Promise<pg.Pool> {
  const urlsToTry = [DEFAULT_URL, 'postgres://tailieu:devpassword@127.0.0.1:5432/tailieu'];
  let lastError: Error | null = null;
  for (const url of urlsToTry) {
    const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await pool.query('SELECT 1');
      return pool;
    } catch (err) {
      lastError = err as Error;
      await pool.end().catch(() => undefined);
    }
  }
  throw lastError ?? new Error('Không thể kết nối cơ sở dữ liệu.');
}

async function main(): Promise<void> {
  const pool = await getWorkingPool();

  try {
    console.log('====================================================');
    console.log('   CÔNG CỤ RÀ SOÁT & THANH LỌC TÀI LIỆU VI PHẠM');
    console.log('   (Bảo vệ Bản quyền & Nhận diện Thương hiệu)');
    console.log('====================================================');

    const auditSql = `
      SELECT d.id, d.title, d.status, d.created_at, dt.name as category_name
      FROM documents d
      LEFT JOIN document_types dt ON d.document_type_id = dt.id
      WHERE d.deleted_at IS NULL
        AND (
          d.title ~* '(TTN|ĐHTN|DHTN|Tây Nguyên|giáo trình|giao trinh)'
          OR d.description ~* '(TTN|Đại học Tây Nguyên|giao trinh)'
          OR dt.code IN ('textbook', 'giao_trinh')
        )
      ORDER BY d.created_at DESC;
    `;

    const res = await pool.query(auditSql);
    const count = res.rowCount ?? 0;

    if (mode === 'audit') {
      console.log(`🔍 [RÀ SOÁT] Tìm thấy ${count} tài liệu có dấu hiệu vi phạm cần xử lý:\n`);
      if (count === 0) {
        console.log('✅ Hệ thống sạch sẽ! Không còn tài liệu vi phạm nào đang công khai.');
      } else {
        console.table(
          res.rows.map((r: { id: string; title: string; category_name: string; status: string }) => ({
            ID: r.id.substring(0, 8) + '...',
            'Tiêu đề': r.title.length > 40 ? r.title.substring(0, 37) + '...' : r.title,
            'Danh mục': r.category_name ?? 'N/A',
            'Trạng thái': r.status,
          }))
        );
        console.log('\n👉 Để gỡ bỏ (soft-delete & lưu trữ), hãy chạy:');
        console.log('   npm run purge:run');
      }
    } else if (mode === 'purge' || mode === 'run') {
      console.log(`⚠️  [THỰC THI] Đang xử lý gỡ bỏ tài liệu vi phạm...`);
      if (count === 0) {
        console.log('✅ Không có tài liệu nào cần gỡ bỏ.');
      } else {
        const purgeSql = `
          UPDATE documents d
          SET deleted_at = NOW(),
              status = 'archived'
          FROM document_types dt
          WHERE d.document_type_id = dt.id
            AND d.deleted_at IS NULL
            AND (
              d.title ~* '(TTN|ĐHTN|DHTN|Tây Nguyên|giáo trình|giao trinh)'
              OR d.description ~* '(TTN|Đại học Tây Nguyên|giao trinh)'
              OR dt.code IN ('textbook', 'giao_trinh')
            );
        `;
        const updateRes = await pool.query(purgeSql);
        console.log(`🧹 [THÀNH CÔNG] Đã ẩn/lưu trữ ${updateRes.rowCount} tài liệu vi phạm!`);
      }

      // Khóa danh mục giáo trình
      await pool.query(`
        UPDATE document_types
        SET is_active = false
        WHERE code IN ('textbook', 'giao_trinh');
      `);
      console.log('🔒 Đã vô hiệu hóa danh mục "Giáo trình" (textbook).');
    } else {
      console.log('Cách dùng:');
      console.log('  npm run purge:audit   -> Rà soát danh sách tài liệu vi phạm');
      console.log('  npm run purge:run     -> Tiến hành gỡ bỏ / lưu trữ tài liệu vi phạm');
    }
    console.log('====================================================');
  } catch (err) {
    console.error('❌ Lỗi xử lý:', (err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('Lỗi nghiêm trọng:', err);
  process.exit(1);
});
