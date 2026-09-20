// Vercel serverless function: /api/contact
// Receives the contact form submission and sends it as an email via Resend
// to the Fagus Ed inbox. Requires a RESEND_API_KEY environment variable to
// be set in the Vercel project (Settings -> Environment Variables).

import { handlePreflight } from './_lib/cors.js';

const TO_EMAIL = 'contacto@fagus-ed.cl';
const FROM_EMAIL = 'Fagus Ed Web <web@fagus-ed.cl>'; // must be on a domain verified in Resend

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Missing RESEND_API_KEY environment variable');
    return res.status(500).json({ error: 'Email service not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { name, email, interest, message } = body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  // Very small sanity check on the email shape; real validation happens client-side too.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  const safeName = escapeHtml(name).slice(0, 200);
  const safeEmail = escapeHtml(email).slice(0, 200);
  const safeInterest = escapeHtml(interest || '-').slice(0, 200);
  const safeMessage = escapeHtml(message).slice(0, 5000);

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [TO_EMAIL],
        reply_to: email,
        subject: `Nueva consulta desde el sitio — ${name}`,
        text:
          `Nombre: ${name}\n` +
          `Email: ${email}\n` +
          `Interés: ${interest || '-'}\n\n` +
          `Mensaje:\n${message}`,
        html:
          `<p><strong>Nombre:</strong> ${safeName}</p>` +
          `<p><strong>Email:</strong> ${safeEmail}</p>` +
          `<p><strong>Interés:</strong> ${safeInterest}</p>` +
          `<p><strong>Mensaje:</strong></p><p>${safeMessage.replace(/\n/g, '<br>')}</p>`
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('Resend API error:', resp.status, errText);
      return res.status(502).json({ error: 'Failed to send email' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact form error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
