function minutesFromElapsed(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  const text = String(value).trim();
  const hms = text.match(/^(\d+):(\d{2}):(\d{2})$/);
  if (hms) {
    return Math.round((Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3])) / 60);
  }
  const ms = text.match(/^(\d+):(\d{2})$/);
  if (ms) {
    return Math.round((Number(ms[1]) * 60 + Number(ms[2])) / 60);
  }
  const minutes = text.match(/^(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)?$/i);
  if (minutes) return Math.round(Number(minutes[1]));
  return null;
}

module.exports = {
  minutesFromElapsed,
};
