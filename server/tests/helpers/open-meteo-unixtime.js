// Builds Open-Meteo `timeformat=unixtime` fixtures from ET wall times. The
// provider returns true UTC epochs (seconds); fixtures are written in ET wall
// time so test bodies stay readable. A wall time here is only ever turned into
// an epoch (never the other way round), and sequences are built by adding whole
// hours, so the fall-back (25 h) and spring-forward (23 h) days are exact.
const { parseETDateTime } = require('../../utils/datetime-et');

// "2026-10-03T12:00" (ET wall, unambiguous outside the DST fold) -> epoch seconds.
function unix(wall) {
  return Math.round(parseETDateTime(wall).getTime() / 1000);
}

// `count` consecutive hourly epochs starting at the ET wall time `startWall`.
function hourlyEpochs(startWall, count) {
  const start = unix(startWall);
  return Array.from({ length: count }, (_, i) => start + i * 3600);
}

// Hours in the ET calendar day `ymd`: 23 on the spring-forward day, 25 on the fall-back day.
function etDayHours(ymd) {
  const next = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10) + 1)).toISOString().slice(0, 10);
  return (unix(`${next}T00:00`) - unix(`${ymd}T00:00`)) / 3600;
}

module.exports = { unix, hourlyEpochs, etDayHours };
