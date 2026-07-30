// Admin-only presentation copy for the flagship newsletter lane. Internal
// API keys such as `local-weekly-fresh-events`, `weekend`, and
// `fresh_this_week` remain stable; operators see the current identity —
// "Waves Newsletter" (owner directive 2026-07-28 v2 — no "The"; replaces the
// 2026-07-17 "Fresh This Week" identity) — and Tuesday editorial cadence
// from this one source.
export const NEWSLETTER_UI_COPY = Object.freeze({
  name: 'Waves Newsletter',
  tagline: '',
  sendCadence: 'Tuesday 6:00 AM ET',
  scheduleHint: 'Waves Newsletter delivery is locked to Tuesday at exactly 6:00 AM ET.',
  calendarWeekHeading: 'Waves Newsletter (Tuesday 6:00 AM ET)',
  weekStartLabel: 'Week starting (Tuesday · 6:00 AM ET delivery)',
});
