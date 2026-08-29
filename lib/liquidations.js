const { v4: uuidv4 } = require('uuid');
const { pool } = require('./db');

async function getStudentLiquidationSummary(studentId) {
  const [tickets] = await pool.query(
    `SELECT tc.id, tc.ticket_number, tc.plan,
            COALESCE((SELECT SUM(b.total_paid) FROM bonos b WHERE b.talonario_id=tc.id), 0) AS collected_amount,
            COALESCE((SELECT COUNT(*) FROM bonos b WHERE b.talonario_id=tc.id AND b.buyer_name IS NOT NULL), 0) AS sold_bonos,
            COALESCE((SELECT SUM(bl.amount) FROM bonus_liquidations bl WHERE bl.talonario_id=tc.id AND bl.status='approved'), 0) AS approved_amount,
            COALESCE((SELECT SUM(bl.amount) FROM bonus_liquidations bl WHERE bl.talonario_id=tc.id AND bl.status='pending'), 0) AS pending_amount
     FROM talonario_catalog tc
     WHERE tc.assigned_to=? AND tc.is_assigned=TRUE
     ORDER BY tc.assigned_at DESC`,
    [studentId]
  );

  const mapped = tickets.map(ticket => ({
    ...ticket,
    collected_amount: Number(ticket.collected_amount || 0),
    approved_amount: Number(ticket.approved_amount || 0),
    pending_amount: Number(ticket.pending_amount || 0),
    sold_bonos: Number(ticket.sold_bonos || 0),
    available_amount: Math.max(0, Number(ticket.collected_amount || 0) - Number(ticket.approved_amount || 0) - Number(ticket.pending_amount || 0))
  }));
  return { tickets: mapped, totalAvailable: mapped.reduce((sum, ticket) => sum + ticket.available_amount, 0) };
}

async function createLiquidationRequest(studentId) {
  const summary = await getStudentLiquidationSummary(studentId);
  const ticket = summary.tickets.find(item => item.available_amount > 0);
  if (!ticket) return { error: 'No tienes recaudo disponible para liquidar todavía.' };

  const id = uuidv4();
  try {
    await pool.query(
      'INSERT INTO bonus_liquidations (id,talonario_id,student_id,amount) VALUES (?,?,?,?)',
      [id, ticket.id, studentId, ticket.available_amount]
    );
  } catch (error) {
    if (error.code === '23505') return { error: 'Ya tienes una liquidación pendiente para este talonario.' };
    throw error;
  }
  return { liquidation: { id, talonario_id: ticket.id, amount: ticket.available_amount, status: 'pending' }, ticket };
}

async function cancelLiquidationRequest(id) {
  await pool.query("DELETE FROM bonus_liquidations WHERE id=? AND status='pending'", [id]);
}

async function saveLiquidationTelegramMessage(id, messageId) {
  await pool.query('UPDATE bonus_liquidations SET telegram_message_id=? WHERE id=?', [messageId, id]);
}

async function processLiquidationDecision(id, action) {
  const status = action === 'approve' ? 'approved' : 'rejected';
  const [rows] = await pool.query(
    `UPDATE bonus_liquidations SET status=?, decided_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='pending'
     RETURNING id, amount, talonario_id, student_id`,
    [status, id]
  );
  if (!rows.length) return { error: 'Esta liquidación ya fue procesada o no existe.' };

  const liquidation = rows[0];
  const [details] = await pool.query(
    `SELECT s.first_name, s.last_name, tc.ticket_number, tc.plan
     FROM talonario_catalog tc
     LEFT JOIN students s ON s.id=tc.assigned_to
     WHERE tc.id=?`,
    [liquidation.talonario_id]
  );
  return {
    success: true,
    liquidation,
    action,
    studentName: details[0] ? `${details[0].first_name || 'Estudiante'} ${details[0].last_name || ''}`.trim() : 'Estudiante',
    ticketNumber: details[0]?.ticket_number,
    plan: details[0]?.plan
  };
}

module.exports = { getStudentLiquidationSummary, createLiquidationRequest, cancelLiquidationRequest, saveLiquidationTelegramMessage, processLiquidationDecision };
