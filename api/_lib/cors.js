// Shared CORS handling for endpoints called both from fagus-ed.cl itself
// (same-origin, no CORS needed) and from timetable.fagus-ed.cl (the
// FagusED TimeTable app, a separate Vercel project/origin).

const ALLOWED_ORIGINS = new Set(['https://timetable.fagus-ed.cl', 'https://fagus-timetable.vercel.app']);

export function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Returns true if the request was a preflight OPTIONS request and has
// already been responded to (caller should return immediately).
export function handlePreflight(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
