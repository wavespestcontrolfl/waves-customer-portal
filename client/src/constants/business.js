export const DEFAULT_FDACS_LICENSE_NUMBER = 'JB351547';

export function normalizeFdacsLicense(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/JB\d{4,}/i);
  return match ? match[0].toUpperCase() : DEFAULT_FDACS_LICENSE_NUMBER;
}

export const WAVES_FDACS_LICENSE_NUMBER = normalizeFdacsLicense(
  import.meta.env.VITE_WAVES_FDACS_LICENSE
);
export const WAVES_FL_LICENSE_LINE = `FL License #${WAVES_FDACS_LICENSE_NUMBER}`;
