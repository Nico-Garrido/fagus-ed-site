// Vercel serverless function: GET /api/availability?date=YYYY-MM-DD&kind=familias
// Returns { slots: ["09:00", "11:00", ...] } — the candidate times for that day
// that do NOT overlap an existing event on the Fagus Ed Google Calendar.

import { zonedTimeToUtc, freeBusy } from './_lib/google.js';

const TIMEZONE = 'America/Santiago';
const CANDIDATE_TIMES = ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
const DURATION = { familias: 30, vocacional: 30, admision: 30, tutoria: 30 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { date, kind } = req.query || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Missing or invalid date (expected YYYY-MM-DD)' });
  }
  const duration = DURATION[kind] || DURATION.familias;

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) {
    console.error('Missing GOOGLE_CALENDAR_ID environment variable');
    return res.status(500).json({ error: 'Calendar not configured' });
  }

  try {
    const dayStartUtc = zonedTimeToUtc(date, '00:00', TIMEZONE);
    const dayEndUtc = zonedTimeToUtc(date, '23:59', TIMEZONE);
    const busy = await freeBusy(calendarId, dayStartUtc.toISOString(), dayEndUtc.toISOString());

    const available = CANDIDATE_TIMES.filter((time) => {
      const start = zonedTimeToUtc(date, time, TIMEZONE);
      const end = new Date(start.getTime() + duration * 60000);
      return !busy.some((b) => {
        const bStart = new Date(b.start);
        const bEnd = new Date(b.end);
        return start < bEnd && end > bStart; // overlap check
      });
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ slots: available });
  } catch (err) {
    console.error('availability error:', err);
    return res.status(502).json({ error: 'Could not check availability' });
  }
}
