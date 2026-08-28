const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { put } = require('@vercel/blob');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../lib/db');
const { requireStudent } = require('../middleware/auth');
const { sendPaymentNotification } = require('../lib/telegram');
const { sendEmail } = require('../lib/email');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // Vercel Function request limit
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|pdf/;
    const ok = allowed.test(file.mimetype);
    cb(ok ? null : new Error('Solo imágenes o PDF'), ok);
  }
});

// ── POST: registrar abono con comprobante ────────────────────
// Sirve tanto para cuotas/total como para pago de talonario
// (se distingue por el campo "type" enviado en el form)
router.post('/payments', requireStudent, upload.single('receipt'), async (req, res) => {
  const { amount, type } = req.body;
  const enrollmentId = req.session.enrollmentId;

  if (!amount || isNaN(amount) || parseInt(amount) < 1000) {
    return res.status(400).json({ error: 'Monto inválido (mínimo $1.000 COP)' });
  }
  if (!enrollmentId) {
    return res.status(400).json({ error: 'No tienes un plan activo. Selecciona tu plan primero.' });
  }

  let receiptUrl = null;
  if (req.file) {
    if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'El almacenamiento de comprobantes aún no está configurado.' });
    const ext = req.file.originalname.split('.').pop().replace(/[^a-z0-9]/gi, '');
    const blob = await put(`receipts/${req.session.studentId}/${uuidv4()}.${ext}`, req.file.buffer, { access: 'public', contentType: req.file.mimetype, addRandomSuffix: true });
    receiptUrl = blob.url;
  }

  const [studentRows] = await pool.query('SELECT * FROM students WHERE id = ?', [req.session.studentId]);
  const [enrollRows]  = await pool.query('SELECT * FROM enrollments WHERE id = ?', [enrollmentId]);
  const student = studentRows[0];
  const enrollment = enrollRows[0];
  if (!student || !enrollment) return res.status(404).json({ error: 'Datos no encontrados' });

  const paymentId = uuidv4();
  const paymentType = type === 'talonario' ? 'talonario' : 'cuota';

  await pool.query(
    `INSERT INTO payments (id, enrollment_id, student_id, amount, receipt_url, status, payment_type)
     VALUES (?,?,?,?,?,'pending',?)`,
    [paymentId, enrollmentId, req.session.studentId, parseInt(amount), receiptUrl, paymentType]
  );

  // Construir URL pública del comprobante para Telegram
  const publicReceiptUrl = receiptUrl;

  let telegramMsgId = null;
  try {
    telegramMsgId = await sendPaymentNotification({
      paymentId,
      student,
      enrollment,
      amount: parseInt(amount),
      receiptUrl: publicReceiptUrl
    });
  } catch (error) {
    // The payment is already stored; a Telegram outage must not block students.
    console.error('Telegram payment notification failed:', error.message);
  }

  if (telegramMsgId) {
    await pool.query('UPDATE payments SET telegram_message_id = ? WHERE id = ?', [telegramMsgId, paymentId]);
  }
  await sendEmail({ to: student.email, subject: 'Recibimos tu comprobante — Summer Class', html: `<p>Hola ${student.first_name},</p><p>Recibimos tu abono de <strong>$${Number(amount).toLocaleString('es-CO')} COP</strong>. Está pendiente de aprobación.</p>` }).catch(console.error);

  res.json({ success: true, paymentId, status: 'pending', redirect: '/dashboard' });
});

module.exports = router;
