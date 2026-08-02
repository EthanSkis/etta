// validate — the input rules shared by every place a family types something:
// the signup form, the manage page, the occasion-call form.

export const TIMEZONES: [string, string][] = [
  ["Eastern time", "America/New_York"],
  ["Central time", "America/Chicago"],
  ["Mountain time", "America/Denver"],
  ["Arizona", "America/Phoenix"],
  ["Pacific time", "America/Los_Angeles"],
  ["Alaska", "America/Anchorage"],
  ["Hawaii", "Pacific/Honolulu"],
];

export const ALLOWED_TIMEZONES = new Set(TIMEZONES.map(([, tz]) => tz));

/** "(208) 315-1420" / "208.315.1420" / "+1 208 315 1420" → "+12083151420" */
export function normalizePhone(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function cleanName(raw: unknown, max = 80): string | null {
  const s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s || s.length > max) return null;
  return s;
}

/** Call times are on the half hour between 06:00 and 20:30, senior-local. */
export function validCallTime(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return /^(0[6-9]|1[0-9]|20):(00|30)$/.test(s) ? s : null;
}

/** "09:00:00" → "9:00 AM" */
export function speakTime(t: string): string {
  const [hs, ms] = t.split(":");
  const h24 = parseInt(hs, 10);
  const h = h24 % 12 || 12;
  return `${h}:${ms} ${h24 < 12 ? "AM" : "PM"}`;
}

/** "09:00:00" → "9 in the morning", "12:30:00" → "12:30 in the afternoon" */
export function timeSpeech(t: string): string {
  const [hs, ms] = t.split(":");
  const h24 = parseInt(hs, 10);
  const m = parseInt(ms, 10);
  const part = h24 < 12 ? "in the morning" : h24 < 17 ? "in the afternoon" : "in the evening";
  const h = h24 % 12 || 12;
  return m === 0 ? `${h} ${part}` : `${h}:${String(m).padStart(2, "0")} ${part}`;
}

/** Today's date in a senior's own timezone, as YYYY-MM-DD. */
export function localDate(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}
