// Vercel serverless function: POST /api/book
// Body: { kind, date (YYYY-MM-DD), time (HH:MM), name, email, phone, extra, notes, lang }
// Re-checks the slot is still free, then creates a real event (with a Google Meet
// link and the visitor as an attendee) on the Fagus Ed Google Calendar.

import { zonedTimeToUtc, freeBusy, createEvent } from './_lib/google.js';
import { handlePreflight } from './_lib/cors.js';

const TIMEZONE = 'America/Santiago';
const DURATION = { familias: 30, vocacional: 30, admision: 30, tutoria: 30, colegios: 30 };
const ADMIN_EMAIL = 'contacto@fagus-ed.cl';
const FROM_EMAIL = 'Fagus Ed <reservas@fagus-ed.cl>'; // must be on a domain verified in Resend

const EVENT_TITLES = {
  familias: { es: 'Asesoría a familias · Fagus Ed', en: 'Family guidance · Fagus Ed' },
  vocacional: { es: 'Orientación vocacional · Fagus Ed', en: 'University guidance · Fagus Ed' },
  admision: { es: 'Admisión en el extranjero · Fagus Ed', en: 'Admissions abroad · Fagus Ed' },
  tutoria: { es: 'Diagnóstico de tutoría · Fagus Ed', en: 'Tutoring diagnostic · Fagus Ed' },
  colegios: { es: 'Soluciones para colegios · Fagus Ed', en: 'Solutions for schools · Fagus Ed' }
};
const EXTRA_LABELS = {
  familias: { es: 'Curso y colegio actual', en: 'Current year group and school' },
  vocacional: { es: 'Curso actual', en: 'Current year group' },
  admision: { es: 'Países o universidades de interés', en: 'Countries or universities of interest' },
  tutoria: { es: 'Asignatura y programa', en: 'Subject and programme' },
  colegios: { es: 'Proceso o necesidad a optimizar', en: 'Process or need to optimise' }
};

// Overrides used when the request comes from the FagusED TimeTable app's own
// "Solicitar acceso" popup, rather than the general fagus-ed.cl contact flow —
// same "colegios" kind/duration, but the visitor is unambiguously asking
// about that product specifically, and gives their school's name, not a
// generic "process to optimise".
const TIMETABLE_SOURCE_EVENT_TITLE = { es: 'Interés en FagusED TimeTable · Fagus Ed', en: 'Interest in FagusED TimeTable · Fagus Ed' };
const TIMETABLE_SOURCE_EXTRA_LABEL = { es: 'Colegio', en: 'School' };

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const { kind, date, time, name, email, phone, extra, notes, lang, source } = body || {};
  const language = lang === 'en' ? 'en' : 'es';

  if (!kind || !DURATION[kind]) return res.status(400).json({ error: 'Invalid or missing kind' });
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Invalid time' });
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Missing name' });
  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'Invalid email' });

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    console.error('Missing GOOGLE_CALENDAR_ID environment variable');
    return res.status(500).json({ error: 'Calendar not configured' });
  }

  const duration = DURATION[kind];
  const start = zonedTimeToUtc(date, time, TIMEZONE);
  const end = new Date(start.getTime() + duration * 60000);

  try {
    // Re-check availability right before booking, to close the race window
    // between the visitor loading the page and clicking "confirm".
    const busy = await freeBusy(calendarId, start.toISOString(), end.toISOString());
    const overlaps = busy.some((b) => {
      const bStart = new Date(b.start);
      const bEnd = new Date(b.end);
      return start < bEnd && end > bStart;
    });
    if (overlaps) {
      return res.status(409).json({ error: 'slot_taken' });
    }

    const fromTimetableApp = source === 'timetable' && kind === 'colegios';
    const title = fromTimetableApp
      ? TIMETABLE_SOURCE_EVENT_TITLE[language]
      : (EVENT_TITLES[kind] && EVENT_TITLES[kind][language]) || EVENT_TITLES.familias[language];
    const extraLabel = fromTimetableApp
      ? TIMETABLE_SOURCE_EXTRA_LABEL[language]
      : (EXTRA_LABELS[kind] && EXTRA_LABELS[kind][language]) || '';
    const descLines = [
      language === 'en' ? 'Request sent from the Fagus Ed website.' : 'Solicitud enviada desde el sitio de Fagus Ed.',
      (language === 'en' ? 'Name: ' : 'Nombre: ') + name,
      'Email: ' + email,
      phone ? (language === 'en' ? 'Phone: ' : 'Teléfono: ') + phone : '',
      extra ? extraLabel + ': ' + extra : '',
      notes ? (language === 'en' ? 'Notes: ' : 'Notas: ') + notes : ''
    ].filter(Boolean);

    // With Domain-Wide Delegation (the service account impersonates
    // contacto@fagus-ed.cl), we can invite the visitor as an attendee and
    // auto-generate a Google Meet link. Explicit `organizer.displayName`
    // makes the native Google invite email show "Invitation from FagusED"
    // instead of a generic/unknown sender.
    const event = await createEvent(calendarId, {
      summary: title,
      description: descLines.join('\n'),
      start: { dateTime: start.toISOString(), timeZone: 'UTC' },
      end: { dateTime: end.toISOString(), timeZone: 'UTC' },
      organizer: { email: calendarId, displayName: 'FagusED' },
      attendees: [{ email }],
      conferenceData: {
        createRequest: {
          requestId: 'fagus-' + Date.now() + '-' + Math.random().toString(36).slice(2),
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    });

    const meetLink =
      (event.conferenceData &&
        event.conferenceData.entryPoints &&
        event.conferenceData.entryPoints[0] &&
        event.conferenceData.entryPoints[0].uri) ||
      null;

    // Google already emails the attendee a native Calendar invite; this is a
    // friendlier, branded confirmation on top of that (and a safety net in
    // case the native invite is delayed or filtered).
    await sendVisitorConfirmationEmail({ language, name, email, title, start, duration, meetLink }).catch((e) =>
      console.error('visitor confirmation email failed (event was still created):', e)
    );
    // Google never emails an event's own organizer an "invitation" — that's
    // by design, not a bug — so contacto@fagus-ed.cl needs its own explicit
    // notification rather than depending on the native Calendar invite.
    await sendAdminNotificationEmail({ name, email, extra, extraLabel, title, start, duration, meetLink }).catch((e) =>
      console.error('admin notification email failed (event was still created):', e)
    );

    return res.status(200).json({ ok: true, meetLink });
  } catch (err) {
    console.error('book error:', err);
    return res.status(502).json({ error: 'Could not create the booking' });
  }
}


function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('Missing RESEND_API_KEY — skipping email:', subject);
    return;
  }
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, reply_to: ADMIN_EMAIL, subject, text, html })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('Resend API error: ' + resp.status + ' ' + errText);
  }
}

async function sendVisitorConfirmationEmail({ language, name, email, title, start, duration, meetLink }) {
  const whenText = start.toLocaleString(language === 'en' ? 'en-US' : 'es-CL', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  const subject = (language === 'en' ? 'Meeting confirmed: ' : 'Reunión confirmada: ') + title;
  const lines =
    language === 'en'
      ? [
          `Hi ${name},`,
          '',
          `Your meeting is confirmed for ${whenText} (Chile time), ${duration} minutes.`,
          meetLink ? `Video call link: ${meetLink}` : '',
          '',
          `Need to reschedule? Just reply to this email or write to ${ADMIN_EMAIL}.`,
          '',
          'Fagus Ed'
        ]
      : [
          `Hola ${name},`,
          '',
          `Tu reunión quedó confirmada para el ${whenText} (hora de Chile), ${duration} minutos.`,
          meetLink ? `Enlace de la videollamada: ${meetLink}` : '',
          '',
          `¿Necesitas reagendar? Responde este correo o escribe a ${ADMIN_EMAIL}.`,
          '',
          'Fagus Ed'
        ];
  const text = lines.filter((l) => l !== '').join('\n');
  const html = lines
    .filter((l) => l !== '')
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join('');

  await sendEmail({ to: [email], subject, text, html });
}

// Google never sends an "invitation" email to an event's own organizer —
// contacto@fagus-ed.cl is that organizer, so it needs its own notification
// rather than depending on (or BCC'ing) the visitor's native Calendar invite.
async function sendAdminNotificationEmail({ name, email, extra, extraLabel, title, start, duration, meetLink }) {
  const whenText = start.toLocaleString('es-CL', {
    timeZone: TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit'
  });

  const subject = 'Nueva reunión agendada: ' + title;
  const lines = [
    `Se agendó una nueva reunión (${duration} min) para el ${whenText} (hora de Chile).`,
    '',
    `Nombre: ${name}`,
    `Email: ${email}`,
    extra ? `${extraLabel || 'Detalle'}: ${extra}` : '',
    meetLink ? `Enlace de la videollamada: ${meetLink}` : '',
    '',
    'Ya quedó agregada al calendario — este correo es solo un aviso.'
  ];
  const text = lines.filter((l) => l !== '').join('\n');
  const html = lines
    .filter((l) => l !== '')
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join('');

  await sendEmail({ to: [ADMIN_EMAIL], subject, text, html });
}
