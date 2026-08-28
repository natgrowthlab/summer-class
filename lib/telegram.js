try { require('dotenv').config(); } catch(e) {}
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendPaymentNotification({ paymentId, student, enrollment, amount, receiptUrl }) {
  const planName = enrollment.plan === 'san_andres' ? '🏝 San Andrés Islas' : '🌊 Costa Atlántica';
  const methodName = { cuotas: 'Cuotas', total: 'Pago Total', talonario: 'Bono de Apoyo' }[enrollment.payment_method];

  const caption =
    `🎒 *Nuevo Abono — Summer Class*\n\n` +
    `👤 *${student.first_name} ${student.last_name}*\n` +
    `📱 ${student.phone}\n` +
    `🏫 ${student.school} · ${student.city}\n` +
    `🗺 Plan: ${planName}\n` +
    `💳 Método: ${methodName}\n` +
    `💵 Monto: *$${Number(amount).toLocaleString('es-CO')} COP*\n\n` +
    `📋 ID Pago: \`${paymentId}\``;

  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Aprobar', callback_data: `approve_${paymentId}` },
      { text: '❌ Rechazar', callback_data: `reject_${paymentId}` }
    ]]
  };

  let res;
  if (receiptUrl) {
    res = await fetch(`${API}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        photo: receiptUrl,
        caption,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      })
    });
  } else {
    res = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT_ID,
        text: caption,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      })
    });
  }

  const data = await res.json();
  return data.result?.message_id?.toString();
}

async function editMessageAfterAction({ chatId, messageId, action, studentName }) {
  const text = action === 'approve'
    ? `✅ *Aprobado* — ${studentName}`
    : `❌ *Rechazado* — ${studentName}`;

  await fetch(`${API}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    })
  });

  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });
}

async function setWebhook() {
  const url = `${process.env.APP_URL}/api/telegram/webhook`;
  const res = await fetch(`${API}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  const data = await res.json();
  console.log('Telegram webhook:', data.description);
}

module.exports = { sendPaymentNotification, editMessageAfterAction, setWebhook };
