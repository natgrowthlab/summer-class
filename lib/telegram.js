try { require('dotenv').config(); } catch(e) {}
const fetch = require('node-fetch');
const { pool } = require('./db');

const SETTING_KEYS = ['telegram_bot_token', 'telegram_admin_chat_id', 'telegram_webhook_secret'];

async function getTelegramConfig() {
  const [rows] = await pool.query('SELECT key, value FROM app_settings WHERE key IN (?,?,?)', SETTING_KEYS);
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return {
    botToken: stored.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: stored.telegram_admin_chat_id || process.env.TELEGRAM_ADMIN_CHAT_ID || '',
    webhookSecret: stored.telegram_webhook_secret || ''
  };
}

function getWebhookUrl() {
  const baseUrl = process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
  return baseUrl ? `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook` : '';
}

async function callTelegram(botToken, method, body) {
  if (!botToken) throw new Error('Configura el token del bot de Telegram primero.');
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.description || 'Telegram no pudo completar la solicitud.');
  return data.result;
}

async function saveTelegramConfig({ botToken, chatId, webhookSecret }) {
  for (const [key, value] of [
    ['telegram_bot_token', botToken],
    ['telegram_admin_chat_id', chatId],
    ['telegram_webhook_secret', webhookSecret]
  ]) {
    await pool.query(
      'INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=CURRENT_TIMESTAMP',
      [key, value]
    );
  }
}

async function setWebhook(config, { notify = false } = {}) {
  const telegram = config || await getTelegramConfig();
  const url = getWebhookUrl();
  if (!url) throw new Error('Configura APP_URL con la URL pública de la aplicación.');
  await callTelegram(telegram.botToken, 'setWebhook', { url, secret_token: telegram.webhookSecret, allowed_updates: ['callback_query'] });
  if (notify) await callTelegram(telegram.botToken, 'sendMessage', { chat_id: telegram.chatId, text: 'summerclass conectado correctamente' });
  return { url };
}

async function sendPaymentNotification({ paymentId, student, enrollment, amount, receiptUrl }) {
  const telegram = await getTelegramConfig();
  if (!telegram.botToken || !telegram.chatId) return null;
  const planName = enrollment.plan === 'san_andres' ? 'San Andrés Islas' : 'Costa Atlántica';
  const methodName = { cuotas: 'Cuotas', total: 'Pago Total', talonario: 'Bono de Apoyo' }[enrollment.payment_method];
  const caption = `*Nuevo abono — Summer Class*\n\nEstudiante: *${student.first_name} ${student.last_name}*\nTeléfono: ${student.phone}\nColegio: ${student.school} · ${student.city}\nPlan: ${planName}\nMétodo: ${methodName}\nMonto: *$${Number(amount).toLocaleString('es-CO')} COP*\n\nID de pago: \`${paymentId}\``;
  const keyboard = { inline_keyboard: [[
    { text: 'Aprobar', callback_data: `approve_${paymentId}` },
    { text: 'Rechazar', callback_data: `reject_${paymentId}` }
  ]] };
  const result = receiptUrl
    ? await callTelegram(telegram.botToken, 'sendPhoto', { chat_id: telegram.chatId, photo: receiptUrl, caption, parse_mode: 'Markdown', reply_markup: keyboard })
    : await callTelegram(telegram.botToken, 'sendMessage', { chat_id: telegram.chatId, text: caption, parse_mode: 'Markdown', reply_markup: keyboard });
  return result?.message_id?.toString();
}

async function sendLiquidationNotification({ liquidation, student, ticket }) {
  const telegram = await getTelegramConfig();
  if (!telegram.botToken || !telegram.chatId) return null;
  const planName = ticket.plan === 'san_andres' ? 'San Andrés Islas' : 'Costa Atlántica';
  const text = `*Solicitud de liquidación — Summer Class*\n\nEstudiante: *${student.first_name} ${student.last_name}*\nTeléfono: ${student.phone}\nColegio: ${student.school}\nPlan: ${planName}\nTalonario: #${ticket.ticket_number}\nBonos vendidos: ${ticket.sold_bonos}\nMonto a recibir: *$${Number(liquidation.amount).toLocaleString('es-CO')} COP*\n\nEl estudiante debe transferir este valor a Summer Class SAS:\nBancolombia Cuenta Ahorros: 70600002695\nLlave: @summerclass`;
  const reply_markup = { inline_keyboard: [[
      { text: 'Aprobar liquidación', callback_data: `liqapprove_${liquidation.id}` },
      { text: 'Rechazar', callback_data: `liqreject_${liquidation.id}` }
    ]] };
  let result;
  if (liquidation.receipt_url) {
    const isPdf = /\.pdf(?:$|\?)/i.test(liquidation.receipt_url);
    result = await callTelegram(telegram.botToken, isPdf ? 'sendDocument' : 'sendPhoto', {
      chat_id: telegram.chatId,
      [isPdf ? 'document' : 'photo']: liquidation.receipt_url,
      caption: text,
      parse_mode: 'Markdown',
      reply_markup
    });
  } else {
    result = await callTelegram(telegram.botToken, 'sendMessage', { chat_id: telegram.chatId, text, parse_mode: 'Markdown', reply_markup });
  }
  return result?.message_id?.toString();
}

async function editMessageAfterAction({ chatId, messageId, action, studentName, warning }) {
  const telegram = await getTelegramConfig();
  await callTelegram(telegram.botToken, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  const status = `${action === 'approve' ? 'Aprobado' : 'Rechazado'} — ${studentName}`;
  await callTelegram(telegram.botToken, 'sendMessage', { chat_id: chatId, text: warning ? `${status}\n\nNota: ${warning}` : status });
}

async function answerCallbackQuery(callbackQueryId, { text = '', showAlert = false } = {}) {
  const telegram = await getTelegramConfig();
  return callTelegram(telegram.botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert
  });
}

module.exports = { getTelegramConfig, saveTelegramConfig, setWebhook, sendPaymentNotification, sendLiquidationNotification, editMessageAfterAction, answerCallbackQuery };
