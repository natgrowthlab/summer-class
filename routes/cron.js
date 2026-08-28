const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../lib/db');
const { sendEmail } = require('../lib/email');
const router = express.Router();

router.get('/reminders', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: 'No autorizado' });
  const [students] = await pool.query(`SELECT s.id,s.first_name,s.email,e.total_cost,e.amount_paid FROM students s JOIN enrollments e ON e.student_id=s.id WHERE e.status='active' AND e.amount_paid<e.total_cost AND NOT EXISTS (SELECT 1 FROM reminder_log r WHERE r.student_id=s.id AND r.sent_at>CURRENT_TIMESTAMP-INTERVAL '7 days')`);
  let sent = 0;
  for (const student of students) {
    const ok = await sendEmail({ to: student.email, subject: 'Recordatorio de saldo — Summer Class', html: `<p>Hola ${student.first_name},</p><p>Tienes un saldo pendiente de <strong>$${(student.total_cost - student.amount_paid).toLocaleString('es-CO')} COP</strong>. Ingresa a tu panel para registrar tu próximo abono.</p>` }).catch(() => false);
    if (ok) { await pool.query('INSERT INTO reminder_log (id,student_id) VALUES (?,?)', [uuidv4(), student.id]); sent++; }
  }
  res.json({ success: true, sent });
});
module.exports = router;
