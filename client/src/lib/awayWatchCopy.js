// Away Watch + Welcome Home (GATE_AWAY_WATCH): every customer-facing string for the Property tab section, in one
// place. The description is the owner-approved draft of 2026-10-31; the owner approves the final words before the flip.
export const AWAY_WATCH_COPY = {
  title: 'Away Watch',
  description: 'Away for the summer? On each visit day, your tech takes three photos of the outside of your home from the ground and flags standing water. The visit before you come back includes a lanai cobweb sweep, and we text you the photos. This is not a security or home-watch service.',
  fromLabel: 'The day you leave',
  untilLabel: 'The day you are back',
  bothDays: 'Choose both days to turn on Away Watch.',
  remove: 'Remove Away Watch',
  summaryOff: 'Not set',
};

// 'YYYY-MM-DD' -> 'Jun 1'. Read as a plain calendar day, never shifted by the viewer's time zone.
export function awayWatchDayLabel(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function awayWatchSummary(prefs) {
  const from = awayWatchDayLabel(prefs?.awayWatchFrom);
  const until = awayWatchDayLabel(prefs?.awayWatchUntil);
  return from && until ? `Away ${from} to ${until}` : AWAY_WATCH_COPY.summaryOff;
}
