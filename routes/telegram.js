const express = require('express');
const router  = express.Router();
const { editMessageAfterAction } = require('../lib/telegram');
const { processPaymentDecision } = require('../lib/paymentActions');

router.post('/webhook', async (req, res) => {
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
