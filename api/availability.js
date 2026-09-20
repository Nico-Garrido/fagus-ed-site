// Vercel serverless function: GET /api/availability?date=YYYY-MM-DD&kind=familias
// Returns { slots: ["09:00", "11:00", ...] } — the candidate times for that day
// that do NOT overlap an existing event on the Fagus Ed Google Calendar.

import { zonedTimeToUtc, freeBusy } from './_lib/google.js';
import { handlePreflight } from './_lib/cors.js';

const TIMEZONE = 'America/Santiago';
const CANDIDATE_TIMES = ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
const DURATION = { familias: 30, vocacional: 30, admision: 30, tutoria: 30, colegios: 30 };

// "colegios" meetings (booked from the FagusED TimeTable app) run on a
// separate, earlier weekly schedule instead of the generic afternoon slots.
// Weekday numbers follow Date#getUTCDay(): 0=Sun, 1=Mon, ... 6=Sat.
const COLEGIOS_WINDOWS_BY_WEEKDAY = {
  1: [['08:30', '10:30']], // Monday
  2: [['08:00', '09:00']], // Tuesday
  3: [
    ['08:00', '09:00'],
    ['13:00', '15:30']
  ], // Wednesday
  4: [['08:00', '09:00']] // Thursday
};

function slotsInRange(startHHMM, endHHMM, stepMin) {
  const [sh, sm] = startHHMM.split(':').map(Number);
  const [eh, em] = endHHMM.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const out = [];
  for (let t = startMin; t + stepMin <= endMin; t += stepMin) {
    out.push(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
  }
  return out;
}

function candidateTimesFor(kind, date, duration) {
  if (kind !== 'colegios') return CANDIDATE_TIMES;
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const windows = COLEGIOS_WINDOWS_BY_WEEKDAY[weekday] || [];
  return windows.flatMap(([start, end]) => slotsInRange(start, end, duration));
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
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

    const available = candidateTimesFor(kind, date, duration).filter((time) => {
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
