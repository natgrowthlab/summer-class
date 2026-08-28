const express = require('express');
const router  = express.Router();
const { editMessageAfterAction, getTelegramConfig } = require('../lib/telegram');
const { processPaymentDecision } = require('../lib/paymentActions');

router.post('/webhook', async (req, res) => {
  const telegram = await getTelegramConfig();
  const suppliedSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (telegram.webhookSecret && suppliedSecret !== telegram.webhookSecret) return res.sendStatus(401);
  res.json({ ok: true }); // Responder rápido a Telegram

  const update = req.body;
  const query = update?.callback_query;
  if (!query) return;

  const [action, paymentId] = (query.data || '').split('_');
  if (!paymentId || !['approve', 'reject'].includes(action)) return;

  try {
    const result = await processPaymentDecision(paymentId, action);
    if (result.error) {
      console.warn('Telegram approval skipped:', result.error);
      return;
    }

    await editMessageAfterAction({
      chatId: query.message.chat.id,
      messageId: query.message.message_id,
      action,
      studentName: result.studentName
    });
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

module.exports = router;
