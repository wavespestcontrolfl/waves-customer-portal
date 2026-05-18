const DEFAULT_FDACS_LICENSE_NUMBER = 'JB351547';

function normalizeFdacsLicense(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/JB\d{4,}/i);
  return match ? match[0].toUpperCase() : DEFAULT_FDACS_LICENSE_NUMBER;
}

const WAVES_FDACS_LICENSE_NUMBER = normalizeFdacsLicense(process.env.WAVES_FDACS_LICENSE);
const WAVES_FL_LICENSE_LINE = `FL License #${WAVES_FDACS_LICENSE_NUMBER}`;

module.exports = {
  DEFAULT_FDACS_LICENSE_NUMBER,
  WAVES_FDACS_LICENSE_NUMBER,
  WAVES_FL_LICENSE_LINE,
  normalizeFdacsLicense,
};
