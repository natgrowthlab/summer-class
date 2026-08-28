async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return false;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html }) });
  if (!response.ok) throw new Error('No se pudo enviar el correo');
  return true;
}
module.exports = { sendEmail };
