const express = require('express');
const router  = express.Router();
const { answerCallbackQuery, editMessageAfterAction, getTelegramConfig } = require('../lib/telegram');
const { processPaymentDecision } = require('../lib/paymentActions');

router.post('/webhook', async (req, res) => {
  const telegram = await getTelegramConfig();
  const suppliedSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (telegram.webhookSecret && suppliedSecret !== telegram.webhookSecret) return res.sendStatus(401);
  const update = req.body;
  const query = update?.callback_query;
  if (!query) return res.json({ ok: true });

  const [action, paymentId] = (query.data || '').split('_');
  if (!paymentId || !['approve', 'reject'].includes(action)) return res.json({ ok: true });

  try {
    const result = await processPaymentDecision(paymentId, action);
    if (result.error) {
      console.warn('Telegram approval skipped:', result.error);
      await answerCallbackQuery(query.id, { text: result.error, showAlert: true });
      return res.json({ ok: true });
    }

    try {
      await answerCallbackQuery(query.id, { text: result.warning || (action === 'approve' ? 'Pago aprobado' : 'Pago rechazado'), showAlert: Boolean(result.warning) });
      await editMessageAfterAction({
        chatId: query.message.chat.id,
        messageId: query.message.message_id,
        action,
        studentName: result.studentName,
        warning: result.warning
      });
    } catch (telegramError) {
      // The decision is already saved; a Telegram display error must not cause a retry.
      console.error('Telegram confirmation failed:', telegramError.message);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    try {
      await answerCallbackQuery(query.id, { text: 'No se pudo procesar el pago. Inténtalo nuevamente.', showAlert: true });
    } catch (_) {}
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
