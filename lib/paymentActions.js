const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');
const { TALONARIO_CONFIG } = require('./helpers');

/**
 * Procesa la aprobación o rechazo de un pago.
 * Si es un pago de talonario aprobado, asigna automáticamente un
 * talonario disponible al azar y genera sus bonos según el plan.
 *
 * Se usa tanto desde el panel admin (botones web) como desde el
 * webhook de Telegram (botones /aprobar /rechazar), para que el
 * comportamiento sea idéntico sin importar por dónde se apruebe.
 */
async function processPaymentDecision(paymentId, action) {
  const [payRows] = await pool.query(
    `SELECT p.*, s.first_name, s.last_name, s.id as student_id,
            e.payment_method, e.plan, e.id as enrollment_id
     FROM payments p
     JOIN students s ON s.id = p.student_id
     JOIN enrollments e ON e.id = p.enrollment_id
     WHERE p.id = ?`,
    [paymentId]
  );
  if (!payRows.length) return { error: 'Pago no encontrado' };
  const payment = payRows[0];
  if (payment.status !== 'pending') return { error: 'Este pago ya fue procesado anteriormente' };

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  await pool.query('UPDATE payments SET status=? WHERE id=?', [newStatus, paymentId]);

  const studentName = `${payment.first_name} ${payment.last_name}`;

  if (action !== 'approve') {
    return { success: true, studentName };
  }

  // Sumar al total pagado del enrollment
  await pool.query(
    'UPDATE enrollments SET amount_paid = amount_paid + ? WHERE id=?',
    [payment.amount, payment.enrollment_id]
  );

  // Si es un pago de talonario, activar enrollment y asignar talonario aleatorio
  const isTalonarioPayment = payment.payment_method === 'talonario' || payment.payment_type === 'talonario';
  if (!isTalonarioPayment) {
    return { success: true, studentName };
  }

  await pool.query(`UPDATE enrollments SET status='active' WHERE id=?`, [payment.enrollment_id]);

  const plan = payment.plan || 'costa_atlantica';
  const config = TALONARIO_CONFIG[plan] || TALONARIO_CONFIG.costa_atlantica;

  const [freeTickets] = await pool.query(
    `SELECT id, ticket_number FROM talonario_catalog WHERE is_assigned=FALSE AND plan=? ORDER BY RAND() LIMIT 1`,
    [plan]
  );

  if (!freeTickets.length) {
    console.warn('⚠️ No hay talonarios disponibles para asignar');
    return { success: true, studentName, warning: 'No hay talonarios disponibles para asignar. Agrega más desde el panel admin.' };
  }

  const ticket = freeTickets[0];
  await pool.query(
    `UPDATE talonario_catalog SET is_assigned=TRUE, assigned_to=?, assigned_at=NOW() WHERE id=?`,
    [payment.student_id, ticket.id]
  );

  // Crear bonos si el talonario no los tiene aún
  const [existingBonos] = await pool.query(
    'SELECT COUNT(*) as cnt FROM bonos WHERE talonario_id=?', [ticket.id]
  );
  if (parseInt(existingBonos[0].cnt) === 0) {
    const bonoNums = new Set();
    while (bonoNums.size < config.bonos_per_ticket) {
      bonoNums.add(Math.floor(1000 + Math.random() * 9000));
    }
    for (const num of bonoNums) {
      await pool.query(
        'INSERT INTO bonos (id, talonario_id, bono_number) VALUES (?,?,?)',
        [uuidv4(), ticket.id, num]
      );
    }
  }

  console.log(`✅ Talonario #${ticket.ticket_number} asignado a ${studentName} (plan: ${plan}, ${config.bonos_per_ticket} bonos)`);
  return { success: true, studentName, ticketAssigned: ticket.ticket_number };
}

module.exports = { processPaymentDecision };
