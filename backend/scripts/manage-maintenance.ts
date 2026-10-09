import pg from 'pg';
import { Redis } from 'ioredis';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load root .env or backend/.env if present
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const DEFAULT_URL =
  process.env.DATABASE_URL ?? 'postgres://tailieu:devpassword@127.0.0.1:5432/tailieu';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const action = (process.argv[2] ?? 'status').toLowerCase();

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
    if (action === 'on') {
      console.log('🔄 Đang kích hoạt chế độ bảo trì hệ thống...');
      await pool.query(`
        INSERT INTO settings (key, value, description, category, updated_at)
        VALUES ('maintenance_mode', 'true'::jsonb, 'Bật để tạm dừng toàn bộ API (trả 503). Chỉ quản trị viên truy cập được.', 'system', NOW())
        ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW();
      `);
      await clearRedisCache();
      console.log('🔒 [THÀNH CÔNG] ĐÃ BẬT CHẾ ĐỘ BẢO TRÌ (maintenance_mode = true)');
      console.log('   Mọi yêu cầu API công khai sẽ nhận phản hồi 503 Service Unavailable.');
    } else if (action === 'off') {
      console.log('🔄 Đang tắt chế độ bảo trì hệ thống...');
      await pool.query(`
        INSERT INTO settings (key, value, description, category, updated_at)
        VALUES ('maintenance_mode', 'false'::jsonb, 'Bật để tạm dừng toàn bộ API (trả 503). Chỉ quản trị viên truy cập được.', 'system', NOW())
        ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = NOW();
      `);
      await clearRedisCache();
      console.log('🔓 [THÀNH CÔNG] ĐÃ TẮT CHẾ ĐỘ BẢO TRÌ (maintenance_mode = false)');
      console.log('   Hệ thống và API đã mở cửa trở lại cho người dùng.');
    } else {
      // status
      const res = await pool.query(
        "SELECT key, value, updated_at FROM settings WHERE key = 'maintenance_mode'"
      );
      const isMaintenance = res.rows[0]?.value === true || res.rows[0]?.value === 'true';
      console.log('====================================================');
      console.log('         TRẠNG THÁI BẢO TRÌ HỆ THỐNG');
      console.log('====================================================');
      console.log(`  Chế độ bảo trì: ${isMaintenance ? '🔒 ĐANG BẬT (ON)' : '🔓 ĐANG TẮT (OFF)'}`);
      console.log(`  Thời gian cập nhật: ${res.rows[0]?.updated_at ?? 'Chưa thiết lập'}`);
      console.log('====================================================');
      console.log('  Cách dùng:');
      console.log('    npm run maintenance:on      -> Bật bảo trì');
      console.log('    npm run maintenance:off     -> Tắt bảo trì');
      console.log('    npm run maintenance:status  -> Xem trạng thái');
      console.log('====================================================');
    }
  } catch (error) {
    console.error('❌ Lỗi khi thực hiện thao tác bảo trì:', (error as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function clearRedisCache(): Promise<void> {
  try {
    const redis = new Redis(REDIS_URL, {
      connectTimeout: 2000,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    await redis.del('setting:maintenance_mode');
    await redis.quit();
  } catch {
    // Redis down or not used; ignored safely
  }
}

main().catch((err) => {
  console.error('Lỗi nghiêm trọng:', err);
  process.exit(1);
});
