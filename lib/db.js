const { neon } = require('@neondatabase/serverless');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Add your Neon connection string.');
// Every query in this app is independent. Neon HTTP avoids persistent
// WebSocket connections, which can be terminated between Vercel invocations.
const sql = neon(process.env.DATABASE_URL, { fullResults: true });
const transientDatabaseError = error => /fetch failed|socket hang up|ECONNRESET|ETIMEDOUT/i.test(error?.message || '');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nativePool = {
  async query(statement, values = []) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await sql.query(statement, values);
      } catch (error) {
        lastError = error;
        if (!transientDatabaseError(error) || attempt === 2) throw error;
        await pause(250 * (attempt + 1));
      }
    }
    throw lastError;
  }
};

function postgres(sql) {
  let n = 0;
  return sql.replace(/INSERT\s+IGNORE\s+INTO/gi, 'INSERT INTO').replace(/ORDER BY RAND\(\)/gi, 'ORDER BY RANDOM()').replace(/NOW\(\)/gi, 'CURRENT_TIMESTAMP').replace(/\?/g, () => `$${++n}`);
}
// Compatibility layer lets existing routes keep MySQL-style ? parameters.
const pool = { async query(sql, values = []) {
  const ignored = /INSERT\s+IGNORE/i.test(sql);
  const result = await nativePool.query(ignored ? `${postgres(sql)} ON CONFLICT DO NOTHING` : postgres(sql), values);
  result.affectedRows = result.rowCount;
  return [result.rows, result];
} };

async function initDB() {
  const schema = [
    `CREATE TABLE IF NOT EXISTS students (id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, phone TEXT NOT NULL, grade TEXT NOT NULL, city TEXT NOT NULL, school TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS enrollments (id UUID PRIMARY KEY, student_id UUID REFERENCES students(id) ON DELETE CASCADE, plan TEXT NOT NULL, payment_method TEXT NOT NULL, total_cost INTEGER NOT NULL, amount_paid INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY, enrollment_id UUID REFERENCES enrollments(id) ON DELETE CASCADE, student_id UUID REFERENCES students(id) ON DELETE CASCADE, amount INTEGER NOT NULL, receipt_url TEXT, status TEXT DEFAULT 'pending', payment_type TEXT DEFAULT 'cuota', telegram_message_id TEXT, notes TEXT, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS talonario_catalog (id UUID PRIMARY KEY, ticket_number INTEGER UNIQUE NOT NULL, is_assigned BOOLEAN DEFAULT FALSE, assigned_to UUID REFERENCES students(id), assigned_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS bonos (id UUID PRIMARY KEY, talonario_id UUID REFERENCES talonario_catalog(id) ON DELETE CASCADE, bono_number INTEGER NOT NULL, buyer_name TEXT, buyer_phone TEXT, cuota1 BOOLEAN DEFAULT FALSE, cuota2 BOOLEAN DEFAULT FALSE, cuota3 BOOLEAN DEFAULT FALSE, total_paid INTEGER DEFAULT 0, created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess JSONB NOT NULL, expire TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS admin_users (id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS login_tokens (token UUID PRIMARY KEY, student_id UUID REFERENCES students(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ)`,
    `CREATE TABLE IF NOT EXISTS reminder_log (id UUID PRIMARY KEY, student_id UUID REFERENCES students(id) ON DELETE CASCADE, sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`
  ];
  for (const statement of schema) await nativePool.query(statement);
  await nativePool.query('CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)');
  console.log('PostgreSQL database initialized');
}

module.exports = { pool, nativePool, initDB };
