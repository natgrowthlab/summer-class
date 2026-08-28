const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../lib/db');
const { requireAdmin, requireRole } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { calcDebt, PLAN_NAMES } = require('../lib/helpers');
const { processPaymentDecision } = require('../lib/paymentActions');
const path = require('path');

// ── Login ─────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.adminUser) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '../public/admin-login.html'));
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = (email || '').toLowerCase();
  const [users] = await pool.query('SELECT * FROM admin_users WHERE email=?', [normalizedEmail]);
  if (!users.length && process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && normalizedEmail === process.env.ADMIN_EMAIL.toLowerCase() && password === process.env.ADMIN_PASSWORD) {
    await pool.query('INSERT INTO admin_users (id,email,password_hash,role) VALUES (?,?,?,?)', [uuidv4(), normalizedEmail, await bcrypt.hash(password, 12), 'owner']);
    req.session.adminUser = { email: normalizedEmail, role: 'owner' };
    return res.json({ success: true, redirect: '/admin' });
  }
  if (!users[0] || !(await bcrypt.compare(password || '', users[0].password_hash))) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  req.session.adminUser = { id: users[0].id, email: users[0].email, role: users[0].role };
  res.json({ success: true, redirect: '/admin' });
});

// ── Panel principal ───────────────────────────────────────────
router.get('/', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// ── API: resumen ──────────────────────────────────────────────
router.get('/api/summary', requireAdmin, async (req, res) => {
  const [studentsRows] = await pool.query('SELECT COUNT(*) as count FROM students');
  const [paymentsInfo] = await pool.query(
    `SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM payments WHERE status='approved'`
  );
  const [enrollRows] = await pool.query(
    `SELECT plan, COUNT(*) as count FROM enrollments WHERE status='active' GROUP BY plan`
  );
  const [pendingRows] = await pool.query(`
    SELECT p.id, p.amount, p.receipt_url, p.created_at, p.payment_type,
           s.first_name, s.last_name, s.phone, s.school,
           e.plan, e.payment_method, e.total_cost, e.amount_paid, e.id as enrollment_id
    FROM payments p
    JOIN students s ON s.id = p.student_id
    JOIN enrollments e ON e.id = p.enrollment_id
    WHERE p.status = 'pending'
    ORDER BY p.created_at ASC`
  );

  res.json({
    totalStudents: parseInt(studentsRows[0].count),
    approvedPayments: parseInt(paymentsInfo[0].count),
    totalCollected: parseInt(paymentsInfo[0].total),
    enrollmentsByPlan: enrollRows,
    pendingPayments: pendingRows
  });
});

// ── API: aprobar/rechazar pago (usa lógica compartida) ─────────
router.post('/api/payments/:id/:action', requireRole('owner', 'manager'), async (req, res) => {
  const { id, action } = req.params;
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Acción inválida' });

  const result = await processPaymentDecision(id, action);
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});

// ── API: lista estudiantes ────────────────────────────────────
router.get('/api/students', requireAdmin, async (req, res) => {
  const [rows] = await pool.query(`
    SELECT s.*, e.plan, e.payment_method, e.total_cost, e.amount_paid, e.status as enrollment_status,
           tc.ticket_number as talonario_number
    FROM students s
    LEFT JOIN enrollments e ON e.student_id=s.id AND e.status='active'
    LEFT JOIN talonario_catalog tc ON tc.assigned_to=s.id AND tc.is_assigned=TRUE
    ORDER BY s.created_at DESC`
  );

  const students = rows.map(s => ({
    ...s,
    debt: s.total_cost ? calcDebt({ total_cost: s.total_cost, amount_paid: s.amount_paid }) : null,
    planName: s.plan ? PLAN_NAMES[s.plan] : null
  }));

  res.json({ students });
});

router.get('/api/export/students.csv', requireAdmin, async (req, res) => {
  const [rows] = await pool.query('SELECT s.first_name,s.last_name,s.email,s.phone,s.school,s.grade,e.plan,e.payment_method,e.total_cost,e.amount_paid,e.status FROM students s LEFT JOIN enrollments e ON e.student_id=s.id ORDER BY s.created_at DESC');
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [['Nombre','Apellido','Correo','Teléfono','Colegio','Grado','Plan','Método','Total','Pagado','Estado'], ...rows.map(Object.values)].map(row => row.map(quote).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.attachment('estudiantes-summer-class.csv'); res.send('\uFEFF' + csv);
});

router.get('/api/admin-users', requireRole('owner'), async (req, res) => { const [users] = await pool.query('SELECT id,email,role,created_at FROM admin_users ORDER BY created_at'); res.json({ users }); });
router.post('/api/admin-users', requireRole('owner'), async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || !['owner','manager','viewer'].includes(role)) return res.status(400).json({ error: 'Datos de usuario inválidos' });
  try { await pool.query('INSERT INTO admin_users (id,email,password_hash,role) VALUES (?,?,?,?)', [uuidv4(), email.toLowerCase(), await bcrypt.hash(password, 12), role]); res.json({ success: true }); }
  catch (_) { res.status(400).json({ error: 'No se pudo crear el usuario.' }); }
});

// ────────────────────────────────────────────────────────────
// ── MÓDULO BONOS DE APOYO ────────────────────────────────────
// ────────────────────────────────────────────────────────────

// ── GET: lista de talonarios en el catálogo ───────────────────
router.get('/api/talonarios', requireAdmin, async (req, res) => {
  const [rows] = await pool.query(`
    SELECT tc.*,
           s.first_name, s.last_name,
           (SELECT COUNT(*) FROM bonos WHERE talonario_id=tc.id) as bono_count,
           (SELECT COUNT(*) FROM bonos WHERE talonario_id=tc.id AND buyer_name IS NOT NULL) as vendidos,
           (SELECT COALESCE(SUM(total_paid),0) FROM bonos WHERE talonario_id=tc.id) as recaudado
    FROM talonario_catalog tc
    LEFT JOIN students s ON s.id=tc.assigned_to
    ORDER BY tc.ticket_number`
  );
  res.json({ talonarios: rows });
});

// ── POST: crear talonario manualmente ─────────────────────────
router.post('/api/talonarios', requireAdmin, async (req, res) => {
  const { ticket_number, bonos } = req.body;
  if (!ticket_number || !bonos || !bonos.length)
    return res.status(400).json({ error: 'Número de talonario y bonos requeridos' });

  const talonarioId = uuidv4();
  try {
    await pool.query('INSERT INTO talonario_catalog (id, ticket_number) VALUES (?,?)', [talonarioId, ticket_number]);
    for (const bonoNumber of bonos) {
      await pool.query('INSERT INTO bonos (id, talonario_id, bono_number) VALUES (?,?,?)', [uuidv4(), talonarioId, bonoNumber]);
    }
    res.json({ success: true, talonario_id: talonarioId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: `Talonario #${ticket_number} ya existe` });
    console.error(err);
    // Limpieza si quedó a medias
    await pool.query('DELETE FROM talonario_catalog WHERE id=?', [talonarioId]).catch(() => {});
    res.status(500).json({ error: 'Error al crear talonario' });
  }
});

// ── POST: importar talonarios en lote (formato JSON) ──────────
router.post('/api/talonarios/bulk', requireAdmin, async (req, res) => {
  const { talonarios } = req.body;
  if (!talonarios || !talonarios.length) return res.status(400).json({ error: 'Sin datos' });

  let created = 0, skipped = 0;
  for (const t of talonarios) {
    const talonarioId = uuidv4();
    try {
      const [result] = await pool.query(
        'INSERT IGNORE INTO talonario_catalog (id, ticket_number) VALUES (?,?)',
        [talonarioId, t.ticket_number]
      );
      if (result.affectedRows === 0) { skipped++; continue; } // ya existía ese ticket_number
      for (const bonoNumber of (t.bonos || [])) {
        await pool.query('INSERT INTO bonos (id, talonario_id, bono_number) VALUES (?,?,?)', [uuidv4(), talonarioId, bonoNumber]);
      }
      created++;
    } catch (e) { skipped++; }
  }

  res.json({ success: true, created, skipped });
});

// ── DELETE: eliminar talonario ────────────────────────────────
router.delete('/api/talonarios/:id', requireAdmin, async (req, res) => {
  const [check] = await pool.query('SELECT is_assigned FROM talonario_catalog WHERE id=?', [req.params.id]);
  if (!check.length) return res.status(404).json({ error: 'No encontrado' });
  if (check[0].is_assigned) return res.status(400).json({ error: 'No se puede eliminar un talonario ya asignado' });

  await pool.query('DELETE FROM talonario_catalog WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ── Logout ────────────────────────────────────────────────────
router.get('/logout', (req, res) => { delete req.session.adminUser; res.redirect('/admin/login'); });

module.exports = router;
