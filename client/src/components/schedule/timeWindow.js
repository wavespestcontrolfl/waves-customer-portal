// Visit times on the Schedule tab (owner 2026-11-02): every time keeps its
// minutes, and AM/PM is written once when both ends share it —
// "7:00–8:00 AM", "8:00–8:30 AM", "12:00–1:00 PM" — or on both ends across
// noon: "11:00 AM–12:00 PM". Inputs are "HH:MM" (seconds ignored).

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(typeof s === 'string' ? s : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function clock(mins) {
  const h24 = Math.floor(mins / 60) % 24;
  return {
    time: `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(mins % 60).padStart(2, '0')}`,
    meridiem: h24 < 12 ? 'AM' : 'PM',
  };
}

// "7:00–8:00 AM"; the start alone ("7:00 AM") when the end is unreadable;
// '' when the start is.
export function formatTimeWindow(start, end) {
  const startMins = parseHHMM(start);
  if (startMins == null) return '';
  const from = clock(startMins);
  const endMins = parseHHMM(end);
  if (endMins == null) return `${from.time} ${from.meridiem}`;
  const to = clock(endMins);
  return from.meridiem === to.meridiem
    ? `${from.time}–${to.time} ${to.meridiem}`
    : `${from.time} ${from.meridiem}–${to.time} ${to.meridiem}`;
}
