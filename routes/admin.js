const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../lib/db');
const { requireAdmin, requireRole } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { calcDebt, PLAN_NAMES, PLAN_COSTS } = require('../lib/helpers');
const { processPaymentDecision } = require('../lib/paymentActions');
const { getTelegramConfig, saveTelegramConfig, setWebhook } = require('../lib/telegram');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const EXCURSION_PLANS = ['costa_atlantica', 'san_andres'];

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(file.originalname.toLowerCase().endsWith('.xlsx') ? null : new Error('Solo se permiten archivos .xlsx'), file.originalname.toLowerCase().endsWith('.xlsx'))
});
const TALONARIO_PLANS = new Set(['costa_atlantica', 'san_andres']);
const planFromSheetName = name => /san\s*andres/i.test(name) ? 'san_andres' : /costa/i.test(name) ? 'costa_atlantica' : null;

async function parseTicketWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const talonarios = [];
  const seen = new Set();
  const ignored = [];

  workbook.eachSheet(sheet => {
    const plan = planFromSheetName(sheet.name);
    if (!plan) { ignored.push(sheet.name); return; }

    for (let column = 1; column <= sheet.columnCount; column++) {
      const ticketCandidates = [];
      const bonos = [];
      for (let row = 1; row <= sheet.rowCount; row++) {
        const text = String(sheet.getCell(row, column).text || '').trim();
        if (/^\d{1,3}$/.test(text)) ticketCandidates.push(Number(text));
        if (/^\d{4}$/.test(text)) bonos.push(Number(text));
      }
      const ticketNumber = ticketCandidates.at(-1);
      if (!ticketNumber || !bonos.length) continue;
      const key = `${plan}:${ticketNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      talonarios.push({ plan, ticket_number: ticketNumber, bonos: [...new Set(bonos)] });
    }
  });
  if (!talonarios.length) throw new Error('No se encontraron talonarios ni boletas de cuatro cifras en el archivo.');
  return { talonarios, ignored };
}

// ── Login ─────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.adminUser) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '../public/admin-login.html'));
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = (email || '').toLowerCase();
  const [users] = await pool.query('SELECT * FROM admin_users WHERE email=?', [normalizedEmail]);
  const isBootstrapOwner = process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && normalizedEmail === process.env.ADMIN_EMAIL.toLowerCase() && password === process.env.ADMIN_PASSWORD;
  if (isBootstrapOwner) {
    if (!users.length) {
      await pool.query('INSERT INTO admin_users (id,email,password_hash,role) VALUES (?,?,?,?)', [uuidv4(), normalizedEmail, await bcrypt.hash(password, 12), 'owner']);
    } else if (users[0].role !== 'owner') {
      await pool.query('UPDATE admin_users SET role=? WHERE email=?', ['owner', normalizedEmail]);
    }
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
  const [liquidationInfo] = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='pending') AS pending_count,
            COUNT(*) FILTER (WHERE status='approved') AS approved_count,
            COALESCE(SUM(amount) FILTER (WHERE status='approved'),0) AS approved_total
     FROM bonus_liquidations`
  );
  const [enrollRows] = await pool.query(
    `SELECT plan, COUNT(*) as count FROM enrollments WHERE status='active' GROUP BY plan`
  );
  const [paymentsByPlan] = await pool.query(
    `SELECT e.plan, COALESCE(SUM(p.amount) FILTER (WHERE p.status='approved'),0) AS collected,
            COUNT(p.id) FILTER (WHERE p.status='approved') AS approved_payments
     FROM enrollments e
     LEFT JOIN payments p ON p.enrollment_id=e.id
     WHERE e.plan IN ('costa_atlantica','san_andres')
     GROUP BY e.plan`
  );
  const [liquidationsByPlan] = await pool.query(
    `SELECT tc.plan, COALESCE(SUM(bl.amount) FILTER (WHERE bl.status='approved'),0) AS collected,
            COUNT(bl.id) FILTER (WHERE bl.status='pending') AS pending_liquidations
     FROM talonario_catalog tc
     LEFT JOIN bonus_liquidations bl ON bl.talonario_id=tc.id
     WHERE tc.plan IN ('costa_atlantica','san_andres')
     GROUP BY tc.plan`
  );
  const [ticketsByPlan] = await pool.query(
    `SELECT plan, COUNT(*) AS tickets,
            COUNT(*) FILTER (WHERE is_assigned=TRUE) AS assigned_tickets,
            COUNT(*) FILTER (WHERE is_assigned=FALSE) AS available_tickets
     FROM talonario_catalog
     WHERE plan IN ('costa_atlantica','san_andres')
     GROUP BY plan`
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

  const grouped = Object.fromEntries(EXCURSION_PLANS.map(plan => [plan, { plan, students: 0, paymentsCollected: 0, liquidationsCollected: 0, collected: 0, approvedPayments: 0, pendingLiquidations: 0, tickets: 0, assignedTickets: 0, availableTickets: 0 }]));
  enrollRows.forEach(row => { if (grouped[row.plan]) grouped[row.plan].students = Number(row.count || 0); });
  paymentsByPlan.forEach(row => {
    if (!grouped[row.plan]) return;
    grouped[row.plan].paymentsCollected = Number(row.collected || 0);
    grouped[row.plan].approvedPayments = Number(row.approved_payments || 0);
  });
  liquidationsByPlan.forEach(row => {
    if (!grouped[row.plan]) return;
    grouped[row.plan].liquidationsCollected = Number(row.collected || 0);
    grouped[row.plan].pendingLiquidations = Number(row.pending_liquidations || 0);
  });
  ticketsByPlan.forEach(row => {
    if (!grouped[row.plan]) return;
    grouped[row.plan].tickets = Number(row.tickets || 0);
    grouped[row.plan].assignedTickets = Number(row.assigned_tickets || 0);
    grouped[row.plan].availableTickets = Number(row.available_tickets || 0);
  });
  Object.values(grouped).forEach(item => { item.collected = item.paymentsCollected + item.liquidationsCollected; });

  res.json({
    totalStudents: parseInt(studentsRows[0].count),
    approvedPayments: parseInt(paymentsInfo[0].count),
    totalCollected: parseInt(paymentsInfo[0].total) + parseInt(liquidationInfo[0].approved_total || 0),
    pendingLiquidations: parseInt(liquidationInfo[0].pending_count || 0),
    approvedLiquidations: parseInt(liquidationInfo[0].approved_count || 0),
    liquidatedCollected: parseInt(liquidationInfo[0].approved_total || 0),
    enrollmentsByPlan: enrollRows,
    excursions: grouped,
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

// Las liquidaciones se aprueban exclusivamente desde los botones de Telegram.
router.get('/api/liquidations', requireAdmin, async (req, res) => {
  const plan = EXCURSION_PLANS.includes(req.query.plan) ? req.query.plan : null;
  const [liquidations] = await pool.query(
    `SELECT bl.*, tc.ticket_number, tc.plan, s.first_name, s.last_name, s.school
     FROM bonus_liquidations bl
     JOIN talonario_catalog tc ON tc.id=bl.talonario_id
     LEFT JOIN students s ON s.id=bl.student_id
     ${plan ? 'WHERE tc.plan=?' : ''}
     ORDER BY CASE bl.status WHEN 'pending' THEN 0 ELSE 1 END, bl.created_at DESC`
    , plan ? [plan] : []
  );
  res.json({ liquidations });
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

router.get('/api/available-bonos', requireAdmin, async (req, res) => {
  const plan = TALONARIO_PLANS.has(req.query.plan) ? req.query.plan : null;
  if (!plan) return res.status(400).json({ error: 'Selecciona una excursión válida.' });
  const [bonos] = await pool.query(
    `SELECT b.id, b.bono_number, tc.ticket_number
     FROM bonos b
     JOIN talonario_catalog tc ON tc.id=b.talonario_id
     WHERE tc.plan=? AND tc.is_assigned=FALSE
     ORDER BY b.bono_number, tc.ticket_number`,
    [plan]
  );
  res.json({ bonos });
});

router.post('/api/students', requireRole('owner', 'manager'), async (req, res) => {
  const { email, first_name, last_name, phone, grade, city, school, plan, bono_id } = req.body;
  if (![email, first_name, last_name, phone, grade, city, school, plan, bono_id].every(value => String(value || '').trim())) {
    return res.status(400).json({ error: 'Completa todos los datos del estudiante.' });
  }
  if (!TALONARIO_PLANS.has(plan)) return res.status(400).json({ error: 'Selecciona una excursión válida.' });
  try {
    const [matchingBonos] = await pool.query(
      `SELECT tc.id AS talonario_id, tc.ticket_number
       FROM bonos b
       JOIN talonario_catalog tc ON tc.id=b.talonario_id
       WHERE b.id=? AND tc.plan=? AND tc.is_assigned=FALSE`,
      [bono_id, plan]
    );
    if (!matchingBonos.length) return res.status(400).json({ error: 'Ese bono ya no está disponible. Selecciona otro.' });

    const id = uuidv4();
    await pool.query(
      'INSERT INTO students (id,email,first_name,last_name,phone,grade,city,school) VALUES (?,?,?,?,?,?,?,?)',
      [id, email.trim().toLowerCase(), first_name.trim(), last_name.trim(), phone.trim(), grade.trim(), city.trim(), school.trim()]
    );
    const [assignment] = await pool.query(
      'UPDATE talonario_catalog SET is_assigned=TRUE,assigned_to=?,assigned_at=CURRENT_TIMESTAMP WHERE id=? AND is_assigned=FALSE',
      [id, matchingBonos[0].talonario_id]
    );
    if (!assignment.affectedRows) {
      await pool.query('DELETE FROM students WHERE id=?', [id]);
      return res.status(400).json({ error: 'Ese bono acaba de ser asignado. Selecciona otro.' });
    }
    await pool.query(
      'INSERT INTO enrollments (id,student_id,plan,payment_method,total_cost,status) VALUES (?,?,?,?,?,?)',
      [uuidv4(), id, plan, 'talonario', PLAN_COSTS[plan], 'active']
    );
    res.json({ success: true, ticket_number: matchingBonos[0].ticket_number, student: { id, email: email.trim().toLowerCase(), first_name: first_name.trim(), last_name: last_name.trim() } });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'Ya existe un estudiante con ese correo.' });
    console.error('Admin student creation failed:', error.message);
    res.status(500).json({ error: 'No se pudo registrar el estudiante.' });
  }
});

router.get('/api/export/students.csv', requireAdmin, async (req, res) => {
  const [rows] = await pool.query('SELECT s.first_name,s.last_name,s.email,s.phone,s.school,s.grade,e.plan,e.payment_method,e.total_cost,e.amount_paid,e.status FROM students s LEFT JOIN enrollments e ON e.student_id=s.id ORDER BY s.created_at DESC');
  const quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = [['Nombre','Apellido','Correo','Teléfono','Colegio','Grado','Plan','Método','Total','Pagado','Estado'], ...rows.map(Object.values)].map(row => row.map(quote).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.attachment('estudiantes-summer-class.csv'); res.send('\uFEFF' + csv);
});

router.delete('/api/students/:id', requireRole('owner'), async (req, res) => {
  const [students] = await pool.query('SELECT id,first_name,last_name FROM students WHERE id=?', [req.params.id]);
  if (!students.length) return res.status(404).json({ error: 'Estudiante no encontrado.' });
  // Preserve the talonario catalog, but make any assigned ticket available again.
  await pool.query('UPDATE talonario_catalog SET is_assigned=FALSE,assigned_to=NULL,assigned_at=NULL WHERE assigned_to=?', [req.params.id]);
  await pool.query('DELETE FROM students WHERE id=?', [req.params.id]);
  res.json({ success: true, studentName: `${students[0].first_name} ${students[0].last_name}` });
});

router.get('/api/admin-users', requireRole('owner'), async (req, res) => { const [users] = await pool.query('SELECT id,email,role,created_at FROM admin_users ORDER BY created_at'); res.json({ users }); });
router.post('/api/admin-users', requireRole('owner'), async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password || password.length < 8 || !['owner','manager','viewer'].includes(role)) return res.status(400).json({ error: 'Datos de usuario inválidos' });
  try { await pool.query('INSERT INTO admin_users (id,email,password_hash,role) VALUES (?,?,?,?)', [uuidv4(), email.toLowerCase(), await bcrypt.hash(password, 12), role]); res.json({ success: true }); }
  catch (_) { res.status(400).json({ error: 'No se pudo crear el usuario.' }); }
});

// ── Integración Telegram ──────────────────────────────────────
router.get('/api/integrations/telegram', requireRole('owner'), async (req, res) => {
  const telegram = await getTelegramConfig();
  res.json({
    configured: Boolean(telegram.botToken && telegram.chatId),
    chatId: telegram.chatId,
    tokenHint: telegram.botToken ? `••••${telegram.botToken.slice(-6)}` : '',
    webhookUrl: process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/api/telegram/webhook` : ''
  });
});

router.put('/api/integrations/telegram', requireRole('owner'), async (req, res) => {
  const { botToken, chatId } = req.body;
  const current = await getTelegramConfig();
  const token = (botToken || '').trim() || current.botToken;
  const targetChatId = (chatId || '').trim() || current.chatId;
  if (!token || !targetChatId) return res.status(400).json({ error: 'Ingresa el token del bot y el Chat ID de Telegram.' });

  const webhookSecret = current.webhookSecret || crypto.randomBytes(32).toString('hex');
  const config = { botToken: token, chatId: targetChatId, webhookSecret };
  await saveTelegramConfig(config);
  try {
    const webhook = await setWebhook(config, { notify: true });
    res.json({ success: true, webhookUrl: webhook.url });
  } catch (error) {
    res.status(400).json({ error: `Configuración guardada, pero Telegram no aceptó el webhook: ${error.message}` });
  }
});

// ────────────────────────────────────────────────────────────
// ── MÓDULO BONOS DE APOYO ────────────────────────────────────
// ────────────────────────────────────────────────────────────

// ── GET: lista de talonarios en el catálogo ───────────────────
router.get('/api/talonarios', requireAdmin, async (req, res) => {
  const plan = EXCURSION_PLANS.includes(req.query.plan) ? req.query.plan : null;
  const [rows] = await pool.query(`
    SELECT tc.*,
           s.first_name, s.last_name,
           (SELECT COUNT(*) FROM bonos WHERE talonario_id=tc.id) as bono_count,
           (SELECT COUNT(*) FROM bonos WHERE talonario_id=tc.id AND buyer_name IS NOT NULL) as vendidos,
           (SELECT COALESCE(SUM(amount),0) FROM bonus_liquidations WHERE talonario_id=tc.id AND status='approved') as recaudado
    FROM talonario_catalog tc
    LEFT JOIN students s ON s.id=tc.assigned_to
    ${plan ? 'WHERE tc.plan=?' : ''}
    ORDER BY tc.plan, tc.ticket_number`
    , plan ? [plan] : []
  );
  res.json({ talonarios: rows });
});

// ── POST: crear talonario manualmente ─────────────────────────
router.post('/api/talonarios', requireAdmin, async (req, res) => {
  const { ticket_number, bonos } = req.body;
  const plan = TALONARIO_PLANS.has(req.body.plan) ? req.body.plan : 'costa_atlantica';
  if (!ticket_number || !bonos || !bonos.length)
    return res.status(400).json({ error: 'Número de talonario y bonos requeridos' });

  const talonarioId = uuidv4();
  try {
    await pool.query('INSERT INTO talonario_catalog (id, ticket_number, plan) VALUES (?,?,?)', [talonarioId, ticket_number, plan]);
    for (const bonoNumber of bonos) {
      await pool.query('INSERT INTO bonos (id, talonario_id, bono_number) VALUES (?,?,?)', [uuidv4(), talonarioId, bonoNumber]);
    }
    res.json({ success: true, talonario_id: talonarioId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' || err.code === '23505') return res.status(400).json({ error: `Talonario #${ticket_number} ya existe para ese plan` });
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
    const plan = TALONARIO_PLANS.has(t.plan) ? t.plan : 'costa_atlantica';
    const talonarioId = uuidv4();
    try {
      const [result] = await pool.query(
        'INSERT IGNORE INTO talonario_catalog (id, ticket_number, plan) VALUES (?,?,?)',
        [talonarioId, t.ticket_number, plan]
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

// ── POST: importar base de boletas desde Excel ────────────────
router.post('/api/talonarios/import-excel', requireAdmin, excelUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Selecciona un archivo Excel (.xlsx).' });
  try {
    const { talonarios, ignored } = await parseTicketWorkbook(req.file.buffer);
    let created = 0, skipped = 0, bonosCreated = 0;

    for (let start = 0; start < talonarios.length; start += 20) {
      const batch = talonarios.slice(start, start + 20).map(ticket => ({ ...ticket, id: uuidv4() }));
      const values = batch.flatMap(ticket => [ticket.id, ticket.ticket_number, ticket.plan]);
      const placeholders = batch.map(() => '(?,?,?)').join(',');
      const [inserted] = await pool.query(
        `INSERT INTO talonario_catalog (id,ticket_number,plan) VALUES ${placeholders}
         ON CONFLICT (plan,ticket_number) DO NOTHING RETURNING id,ticket_number,plan`,
        values
      );
      const insertedKeys = new Set(inserted.map(ticket => `${ticket.plan}:${ticket.ticket_number}`));
      const newTickets = batch.filter(ticket => insertedKeys.has(`${ticket.plan}:${ticket.ticket_number}`));
      created += newTickets.length;
      skipped += batch.length - newTickets.length;

      const bonoValues = newTickets.flatMap(ticket => ticket.bonos.flatMap(number => [uuidv4(), ticket.id, number]));
      if (bonoValues.length) {
        const bonoPlaceholders = Array.from({ length: bonoValues.length / 3 }, () => '(?,?,?)').join(',');
        await pool.query(`INSERT INTO bonos (id,talonario_id,bono_number) VALUES ${bonoPlaceholders}`, bonoValues);
        bonosCreated += bonoValues.length / 3;
      }
    }

    res.json({ success: true, created, skipped, bonosCreated, ignored });
  } catch (error) {
    console.error('Excel ticket import failed:', error.message);
    res.status(400).json({ error: error.message || 'No se pudo importar el archivo.' });
  }
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
