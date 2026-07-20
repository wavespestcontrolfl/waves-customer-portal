// Admin-only presentation copy for the flagship newsletter lane. Internal
// API keys such as `local-weekly-fresh-events`, `weekend`, and
// `fresh_this_week` remain stable; operators see the current identity —
// "Fresh This Week" (owner directive 2026-07-17) — and Tuesday editorial
// cadence from this one source.
export const NEWSLETTER_UI_COPY = Object.freeze({
  name: 'Fresh This Week',
  tagline: 'A local weekend guide from the Waves crew',
  sendCadence: 'Tuesday 6:00 AM ET',
  scheduleHint: 'Fresh This Week delivery is locked to Tuesday at exactly 6:00 AM ET.',
  calendarWeekHeading: 'Fresh This Week (Tuesday 6:00 AM ET)',
  weekStartLabel: 'Week starting (Tuesday · 6:00 AM ET delivery)',
});
