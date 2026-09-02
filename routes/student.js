const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../lib/db');
const { requireStudent } = require('../middleware/auth');
const { PLAN_NAMES, PLAN_COSTS, TALONARIO_CONFIG, calcDebt } = require('../lib/helpers');
const path = require('path');
const { sendEmail } = require('../lib/email');
const { getTelegramConfig, sendLiquidationNotification } = require('../lib/telegram');
const { getStudentLiquidationSummary, createLiquidationRequest, cancelLiquidationRequest, saveLiquidationTelegramMessage } = require('../lib/liquidations');

// ── Landing ──────────────────────────────────────────────────
router.get('/', (req, res) => {
  if (req.session.studentId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Login page ────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.studentId) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

// ── POST login (por email) ────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Ingresa tu correo' });

  const [rows] = await pool.query('SELECT * FROM students WHERE email = ?', [email.toLowerCase()]);
  if (!rows.length) return res.status(404).json({ error: 'Correo no encontrado. ¿Ya tienes cuenta?' });

  const student = rows[0];
  req.session.studentId = student.id;
  req.session.studentName = student.first_name + ' ' + student.last_name;

  const [enroll] = await pool.query(
    'SELECT id FROM enrollments WHERE student_id = ? ORDER BY created_at DESC LIMIT 1',
    [student.id]
  );
  if (enroll.length) req.session.enrollmentId = enroll[0].id;

  res.json({ success: true, redirect: '/dashboard' });
});

// Passwordless recovery/access link. Never reveals whether an address exists.
router.post('/request-access', async (req, res) => {
  const email = (req.body.email || '').toLowerCase();
  const [students] = await pool.query('SELECT id,first_name FROM students WHERE email=?', [email]);
  if (students[0] && process.env.APP_URL) {
    const token = uuidv4();
    await pool.query('INSERT INTO login_tokens (token,student_id,expires_at) VALUES (?,?,CURRENT_TIMESTAMP + INTERVAL \'30 minutes\')', [token, students[0].id]);
    const link = `${process.env.APP_URL}/access/${token}`;
    await sendEmail({ to: email, subject: 'Accede a Summer Class', html: `<p>Hola ${students[0].first_name},</p><p>Usa este enlace seguro para acceder a tu cuenta. Vence en 30 minutos:</p><p><a href="${link}">Acceder a Summer Class</a></p>` }).catch(console.error);
  }
  res.json({ success: true, message: 'Si el correo está registrado, recibirás un enlace de acceso.' });
});

router.get('/access/:token', async (req, res) => {
  const [tokens] = await pool.query('SELECT student_id FROM login_tokens WHERE token=? AND used_at IS NULL AND expires_at>CURRENT_TIMESTAMP', [req.params.token]);
  if (!tokens[0]) return res.status(400).send('Este enlace expiró o ya fue usado. Solicita uno nuevo.');
  await pool.query('UPDATE login_tokens SET used_at=CURRENT_TIMESTAMP WHERE token=?', [req.params.token]);
  const [students] = await pool.query('SELECT * FROM students WHERE id=?', [tokens[0].student_id]);
  req.session.studentId = students[0].id; req.session.studentName = `${students[0].first_name} ${students[0].last_name}`;
  res.redirect('/dashboard');
});

// ── Registro page ─────────────────────────────────────────────
router.get('/registro', (req, res) => {
  if (req.session.studentId) return res.redirect('/select-plan');
  res.sendFile(path.join(__dirname, '../public/registro.html'));
});

// ── POST registro ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, first_name, last_name, phone, grade, city, school } = req.body;
  if (!email || !first_name || !last_name || !phone || !grade || !city || !school)
    return res.status(400).json({ error: 'Todos los campos son requeridos' });

  try {
    const [existing] = await pool.query('SELECT id FROM students WHERE email = ?', [email.toLowerCase()]);
    let studentId;

    if (existing.length) {
      studentId = existing[0].id;
    } else {
      studentId = uuidv4();
      await pool.query(
        `INSERT INTO students (id, email, first_name, last_name, phone, grade, city, school)
         VALUES (?,?,?,?,?,?,?,?)`,
        [studentId, email.toLowerCase(), first_name, last_name, phone, grade, city, school]
      );
    }

    req.session.studentId = studentId;
    req.session.studentName = first_name + ' ' + last_name;
    res.json({ success: true, redirect: '/select-plan' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.json({ success: true, redirect: '/select-plan' });
    console.error(err);
    res.status(500).json({ error: 'Error al registrar. Intenta de nuevo.' });
  }
});

// ── Select plan page ──────────────────────────────────────────
router.get('/select-plan', requireStudent, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/select-plan.html'));
});

router.post('/select-plan', requireStudent, async (req, res) => {
  const { plan, payment_method } = req.body;
  if (!plan || !payment_method) return res.status(400).json({ error: 'Selecciona plan y método de pago' });

  const total_cost = PLAN_COSTS[plan];
  if (!total_cost) return res.status(400).json({ error: 'Plan inválido' });

  try {
    // A student can be removed from the admin panel while their browser keeps
    // an old cookie. Never try to create an enrollment with that stale id.
    const [students] = await pool.query('SELECT id FROM students WHERE id=?', [req.session.studentId]);
    if (!students.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Tu sesión ya no es válida. Regístrate nuevamente para continuar.', redirect: '/registro' });
    }

    const [existing] = await pool.query(
      `SELECT id FROM enrollments WHERE student_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      [req.session.studentId]
    );

    let enrollmentId;
    if (existing.length) {
      enrollmentId = existing[0].id;
      await pool.query(
        'UPDATE enrollments SET plan=?, payment_method=?, total_cost=? WHERE id=?',
        [plan, payment_method, total_cost, enrollmentId]
      );
    } else {
      enrollmentId = uuidv4();
      await pool.query(
        `INSERT INTO enrollments (id, student_id, plan, payment_method, total_cost) VALUES (?,?,?,?,?)`,
        [enrollmentId, req.session.studentId, plan, payment_method, total_cost]
      );
    }

    req.session.enrollmentId = enrollmentId;
    const redirect = payment_method === 'talonario' ? '/talonario-pago' : '/pagar';
    res.json({ success: true, redirect });
  } catch (error) {
    console.error('Student onboarding failed:', error.message);
    res.status(500).json({ error: 'No pudimos guardar tu plan. Inténtalo nuevamente.' });
  }
});

// ── Talonario pago page ───────────────────────────────────────
router.get('/talonario-pago', requireStudent, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/talonario-pago.html'));
});

// ── Activar talonario (ya pagué + número) ────────────────────
router.post('/api/activate-talonario', requireStudent, async (req, res) => {
  const { talonario_number, plan } = req.body;
  if (!talonario_number) return res.status(400).json({ error: 'Ingresa el número de talonario' });
  if (!PLAN_COSTS[plan]) return res.status(400).json({ error: 'Selecciona un destino válido.' });

  const [rows] = await pool.query(
    `SELECT tc.* FROM talonario_catalog tc
     WHERE tc.ticket_number = ? AND tc.plan = ? AND tc.is_assigned = TRUE AND tc.assigned_to = ?`,
    [talonario_number, plan, req.session.studentId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Talonario no encontrado o no asignado a tu cuenta. Contacta al admin.' });
  }
  try {
    const [students] = await pool.query('SELECT id FROM students WHERE id=?', [req.session.studentId]);
    if (!students.length) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Tu sesión ya no es válida. Regístrate nuevamente para continuar.', redirect: '/registro' });
    }
    const [existing] = await pool.query(
      `SELECT id FROM enrollments WHERE student_id=? AND status='active' ORDER BY created_at DESC LIMIT 1`,
      [req.session.studentId]
    );
    const enrollmentId = existing[0]?.id || uuidv4();
    if (existing.length) {
      await pool.query('UPDATE enrollments SET plan=?, payment_method=?, total_cost=? WHERE id=?', [plan, 'talonario', PLAN_COSTS[plan], enrollmentId]);
    } else {
      await pool.query('INSERT INTO enrollments (id,student_id,plan,payment_method,total_cost) VALUES (?,?,?,?,?)', [enrollmentId, req.session.studentId, plan, 'talonario', PLAN_COSTS[plan]]);
    }
    req.session.enrollmentId = enrollmentId;
    res.json({ success: true, redirect: '/dashboard' });
  } catch (error) {
    console.error('Talonario activation failed:', error.message);
    res.status(500).json({ error: 'No pudimos activar tu talonario. Inténtalo nuevamente.' });
  }
});

// ── Pagar page ────────────────────────────────────────────────
router.get('/pagar', requireStudent, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pagar.html'));
});

// ── Pending page ──────────────────────────────────────────────
router.get('/pending', requireStudent, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/pending.html'));
});

// ── Dashboard ─────────────────────────────────────────────────
router.get('/dashboard', requireStudent, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

// ── Talonario bonos page ──────────────────────────────────────
router.get('/talonario', requireStudent, (req, res) => {
  res.sendFile(path.join(__dirname, '../public/talonario.html'));
});

// ── API: dashboard data ───────────────────────────────────────
router.get('/api/dashboard-data', requireStudent, async (req, res) => {
  const [studentRows] = await pool.query('SELECT * FROM students WHERE id = ?', [req.session.studentId]);
  const student = studentRows[0];
  if (!student) return res.status(404).json({ error: 'Estudiante no encontrado' });

  const [enrollRows] = await pool.query(
    `SELECT * FROM enrollments WHERE student_id = ? ORDER BY created_at DESC LIMIT 1`,
    [req.session.studentId]
  );
  const enrollment = enrollRows[0];
  if (!enrollment) return res.json({ student, enrollment: null });

  if (enrollment.payment_method === 'talonario') {
    const [talRows] = await pool.query(
      `SELECT * FROM talonario_catalog WHERE assigned_to = ? AND is_assigned = TRUE LIMIT 1`,
      [req.session.studentId]
    );
    const talonario = talRows[0] || null;
    let bonos = [];
    if (talonario) {
      const [bonosRows] = await pool.query(
        `SELECT * FROM bonos WHERE talonario_id = ? ORDER BY bono_number`,
        [talonario.id]
      );
      bonos = bonosRows;
    }
    return res.json({ student, enrollment, talonario, bonos });
  }

  const [paymentsRows] = await pool.query(
    `SELECT * FROM payments WHERE enrollment_id = ? ORDER BY created_at DESC`,
    [enrollment.id]
  );
  const debt = calcDebt(enrollment);
  res.json({ student, enrollment, payments: paymentsRows, debt, planName: PLAN_NAMES[enrollment.plan] });
});

// ── API: bonos del estudiante ─────────────────────────────────
router.get('/api/bonos/my', requireStudent, async (req, res) => {
  const [talRows] = await pool.query(
    `SELECT * FROM talonario_catalog WHERE assigned_to = ? AND is_assigned = TRUE LIMIT 1`,
    [req.session.studentId]
  );
  if (!talRows.length) return res.status(404).json({ error: 'No tienes un talonario asignado aún' });

  const [bonosRows] = await pool.query(
    `SELECT * FROM bonos WHERE talonario_id = ? ORDER BY bono_number`,
    [talRows[0].id]
  );
  res.json({ talonario_number: talRows[0].ticket_number, bonos: bonosRows });
});

// ── API: saldo de bonos y solicitud de liquidación ───────────
router.get('/api/bonos/liquidation-summary', requireStudent, async (req, res) => {
  const summary = await getStudentLiquidationSummary(req.session.studentId);
  res.json(summary);
});

router.post('/api/bonos/liquidate', requireStudent, async (req, res) => {
  const telegram = await getTelegramConfig();
  if (!telegram.botToken || !telegram.chatId) {
    return res.status(503).json({ error: 'Las liquidaciones aún no están conectadas a Telegram. Contacta al administrador.' });
  }

  const [students] = await pool.query('SELECT first_name,last_name,phone,school FROM students WHERE id=?', [req.session.studentId]);
  if (!students[0]) return res.status(404).json({ error: 'Estudiante no encontrado.' });

  const result = await createLiquidationRequest(req.session.studentId);
  if (result.error) return res.status(400).json({ error: result.error });

  try {
    const messageId = await sendLiquidationNotification({
      liquidation: result.liquidation,
      student: students[0],
      ticket: result.ticket
    });
    if (!messageId) throw new Error('Telegram no está disponible.');
    await saveLiquidationTelegramMessage(result.liquidation.id, messageId);
    return res.json({ success: true, amount: result.liquidation.amount, message: 'Solicitud enviada a aprobación por Telegram.' });
  } catch (error) {
    await cancelLiquidationRequest(result.liquidation.id);
    console.error('Liquidation Telegram notification failed:', error.message);
    return res.status(503).json({ error: 'No se pudo enviar la liquidación a Telegram. Inténtalo de nuevo en unos minutos.' });
  }
});

// ── API: asignar comprador a bono ─────────────────────────────
router.post('/api/bonos/assign-buyer', requireStudent, async (req, res) => {
  const { bono_id, buyer_name, buyer_phone } = req.body;
  if (!bono_id || !buyer_name || !buyer_phone) return res.status(400).json({ error: 'Datos incompletos' });

  const [check] = await pool.query(
    `SELECT b.id FROM bonos b
     JOIN talonario_catalog tc ON tc.id = b.talonario_id
     WHERE b.id = ? AND tc.assigned_to = ?`,
    [bono_id, req.session.studentId]
  );
  if (!check.length) return res.status(403).json({ error: 'Bono no encontrado' });

  await pool.query('UPDATE bonos SET buyer_name=?, buyer_phone=? WHERE id=?', [buyer_name, buyer_phone, bono_id]);
  res.json({ success: true });
});

// ── API: registrar pago de cuota de bono ──────────────────────
router.post('/api/bonos/pay-cuota', requireStudent, async (req, res) => {
  const { bono_id, cuota_num } = req.body;
  if (!bono_id || !cuota_num) return res.status(400).json({ error: 'Datos incompletos' });

  const cuotaField = `cuota${cuota_num}`;
  if (!['cuota1', 'cuota2', 'cuota3'].includes(cuotaField)) return res.status(400).json({ error: 'Cuota inválida' });

  const [check] = await pool.query(
    `SELECT b.id, b.${cuotaField} as already_paid, e.plan
     FROM bonos b
     JOIN talonario_catalog tc ON tc.id = b.talonario_id
     JOIN enrollments e ON e.student_id = tc.assigned_to AND e.payment_method = 'talonario'
     WHERE b.id = ? AND tc.assigned_to = ?`,
    [bono_id, req.session.studentId]
  );
  if (!check.length) return res.status(403).json({ error: 'Bono no encontrado' });
  if (check[0].already_paid) return res.status(400).json({ error: 'Esta cuota ya fue registrada' });

  const plan = check[0].plan || 'costa_atlantica';
  const cfg = TALONARIO_CONFIG[plan] || TALONARIO_CONFIG.costa_atlantica;
  const cuotaAmount = Math.round(cfg.bono_price / cfg.cuotas);

  await pool.query(
    `UPDATE bonos SET ${cuotaField} = TRUE, total_paid = total_paid + ? WHERE id = ?`,
    [cuotaAmount, bono_id]
  );
  res.json({ success: true, amount_registered: cuotaAmount });
});

// ── Logout ────────────────────────────────────────────────────
router.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

module.exports = router;
