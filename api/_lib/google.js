// Shared Google Calendar helper for the booking endpoints.
// Uses a Google service account (no external npm dependencies — signs its own JWT
// with Node's built-in crypto module) so no build step / package.json is needed.
//
// Required environment variables (set in Vercel -> Settings -> Environment Variables):
//   GOOGLE_SA_KEY_BASE64   the ENTIRE downloaded service-account JSON file,
//                          base64-encoded as a single line (see README instructions).
//                          This avoids any risk of newlines inside the private key
//                          getting mangled by a single-line env var text box.
//   GOOGLE_CALENDAR_ID     the calendar to read/write, e.g. contacto@fagus-ed.cl

import crypto from 'crypto';

let cachedServiceAccount = null;

function loadServiceAccount() {
  if (cachedServiceAccount) return cachedServiceAccount;
  const b64 = process.env.GOOGLE_SA_KEY_BASE64;
  if (!b64) throw new Error('Missing GOOGLE_SA_KEY_BASE64');
  let parsed;
  try {
    const json = Buffer.from(b64.trim(), 'base64').toString('utf8');
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error('GOOGLE_SA_KEY_BASE64 is not valid base64-encoded JSON: ' + e.message);
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account JSON is missing client_email or private_key');
  }
  cachedServiceAccount = parsed;
  return parsed;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar';

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Reused across warm invocations of the same serverless instance to avoid
// re-authenticating on every request.
let cachedToken = null;

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const { client_email: email, private_key: privateKey } = loadServiceAccount();
  // Impersonate the real calendar owner via Workspace Domain-Wide Delegation.
  // Without this, a plain service account can't invite attendees or create
  // Google Meet links on someone else's calendar.
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || process.env.GOOGLE_CALENDAR_ID;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: email,
    sub: impersonate,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  const unsigned = base64url(JSON.stringify(header)) + '.' + base64url(JSON.stringify(claim));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const jwt = unsigned + '.' + signature;

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      'grant_type=' +
      encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' +
      encodeURIComponent(jwt)
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('Google auth failed: ' + resp.status + ' ' + errText);
  }
  const data = await resp.json();
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

// Converts a "wall clock" date + time in a given IANA timezone (e.g. America/Santiago)
// into the real UTC instant it corresponds to. Handles DST automatically via Intl.
export function zonedTimeToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [hh, mi] = timeStr.split(':').map(Number);
  const utcGuess = new Date(Date.UTC(y, mo - 1, d, hh, mi, 0));
  const asLocalString = utcGuess.toLocaleString('en-US', { timeZone });
  const asLocalDate = new Date(asLocalString);
  const offset = utcGuess.getTime() - asLocalDate.getTime();
  return new Date(utcGuess.getTime() + offset);
}

export async function freeBusy(calendarId, timeMinISO, timeMaxISO) {
  const token = await getAccessToken();
  const resp = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id: calendarId }] })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('freeBusy failed: ' + resp.status + ' ' + errText);
  }
  const data = await resp.json();
  return (data.calendars && data.calendars[calendarId] && data.calendars[calendarId].busy) || [];
}

export async function createEvent(calendarId, event) {
  const token = await getAccessToken();
  const resp = await fetch(
    'https://www.googleapis.com/calendar/v3/calendars/' +
      encodeURIComponent(calendarId) +
      '/events?sendUpdates=all&conferenceDataVersion=1',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    }
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error('createEvent failed: ' + resp.status + ' ' + errText);
  }
  return resp.json();
}
