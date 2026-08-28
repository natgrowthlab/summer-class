try { require('dotenv').config(); } catch(e) {}
const express = require('express');
const session = require('express-session');
const path = require('path');
const { pool, initDB } = require('./lib/db');
const { setWebhook } = require('./lib/telegram');

const app = express();
// Vercel terminates HTTPS at its proxy; this lets express-session issue secure
// cookies to visitors while keeping a single trusted proxy hop.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
// Each serverless instance waits for the schema before its session middleware
// queries PostgreSQL (important on the first request after a deployment).
const databaseReady = initDB();

// ── Middleware ──────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(async (req, res, next) => { try { await databaseReady; next(); } catch (error) { next(error); } });

class PostgresSessionStore extends session.Store {
  get(sid, cb) { pool.query('SELECT sess FROM sessions WHERE sid=? AND expire>CURRENT_TIMESTAMP', [sid]).then(([rows]) => cb(null, rows[0]?.sess)).catch(cb); }
  set(sid, sess, cb) { const expire = new Date(sess.cookie?.expires || Date.now() + 7 * 864e5); pool.query('INSERT INTO sessions (sid,sess,expire) VALUES (?,?,?) ON CONFLICT (sid) DO UPDATE SET sess=EXCLUDED.sess,expire=EXCLUDED.expire', [sid, JSON.stringify(sess), expire]).then(() => cb?.()).catch(cb); }
  destroy(sid, cb) { pool.query('DELETE FROM sessions WHERE sid=?', [sid]).then(() => cb?.()).catch(cb); }
}

app.use(session({
  store: new PostgresSessionStore(),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
}));

// ── Rutas ───────────────────────────────────────────────────
app.use('/', require('./routes/student'));
app.use('/api', require('./routes/payments'));
app.use('/api', require('./routes/config'));
app.use('/api/telegram', require('./routes/telegram'));
app.use('/api/cron', require('./routes/cron'));
app.use('/admin', require('./routes/admin'));

// ── 404 ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ── Error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Iniciar ──────────────────────────────────────────────────
async function start() {
  await databaseReady;
  if (process.env.APP_URL && process.env.TELEGRAM_BOT_TOKEN) {
    await setWebhook();
  }
  if (!process.env.VERCEL) app.listen(PORT, () => console.log(`Summer Class corriendo en puerto ${PORT}`));
}

if (!process.env.VERCEL) start().catch(err => { console.error('❌ Error al iniciar:', err.message); process.exit(1); });
else start().catch(err => console.error('❌ Error al iniciar:', err.message));

module.exports = app;
