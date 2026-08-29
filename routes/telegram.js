const express = require('express');
const router  = express.Router();
const { answerCallbackQuery, editMessageAfterAction, getTelegramConfig } = require('../lib/telegram');
const { processPaymentDecision } = require('../lib/paymentActions');
const { processLiquidationDecision } = require('../lib/liquidations');

router.post('/webhook', async (req, res) => {
  const telegram = await getTelegramConfig();
  const suppliedSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
  if (telegram.webhookSecret && suppliedSecret !== telegram.webhookSecret) return res.sendStatus(401);
  const update = req.body;
  const query = update?.callback_query;
  if (!query) return res.json({ ok: true });

  const [action, targetId] = (query.data || '').split('_');
  const isLiquidation = ['liqapprove', 'liqreject'].includes(action);
  if (!targetId || (!isLiquidation && !['approve', 'reject'].includes(action))) return res.json({ ok: true });

  try {
    const decisionAction = action === 'liqapprove' ? 'approve' : action === 'liqreject' ? 'reject' : action;
    const result = isLiquidation
      ? await processLiquidationDecision(targetId, decisionAction)
      : await processPaymentDecision(targetId, decisionAction);
    if (result.error) {
      console.warn('Telegram approval skipped:', result.error);
      await answerCallbackQuery(query.id, { text: result.error, showAlert: true });
      return res.json({ ok: true });
    }

    try {
      const approvedText = isLiquidation ? 'Liquidación aprobada' : 'Pago aprobado';
      const rejectedText = isLiquidation ? 'Liquidación rechazada' : 'Pago rechazado';
      await answerCallbackQuery(query.id, { text: result.warning || (decisionAction === 'approve' ? approvedText : rejectedText), showAlert: Boolean(result.warning) });
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
