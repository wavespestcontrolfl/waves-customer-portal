// Typed termite fields already rendered by TermiteReportV2 so the page's
// fallback findings card never prints them twice.
export const TERMITE_V2_DASHBOARD_FIELD_KEYS = new Set([
  'total_stations',
  'stations_checked',
  'stations_inaccessible',
  'stations_with_activity',
  'termite_activity',
  'active_station_location',
  'bait_consumption',
]);
