// Customer copy screen for the pre-treat certificate's free-text
// final-exterior fields, which print on the customer notice
// (GATE_PRETREAT_STICKER_REPORT). One rule for the admin write guard, the
// public /data egress and the staff preview, so all three agree.
const { customerCopyViolations, containsReportAccessCode } = require('./service-report/technician-report-copy');

const FINAL_EXTERIOR_TEXT_KEYS = ['final_exterior_product', 'final_exterior_active_ingredient', 'final_exterior_applicator_name'];

// final_exterior_time is a form time input ("HH:MM"); anything else written
// through the API would print verbatim, so it fails the screen too.
function isClockTime(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value ?? '').trim());
  return Boolean(match) && Number(match[1]) < 24 && Number(match[2]) < 60;
}

function parseFindings(findings) {
  if (typeof findings !== 'string') return findings;
  try { return JSON.parse(findings); } catch { return null; }
}

// Keys whose value carries a banned claim or an access code, plus a
// final_exterior_time that is not a clock time.
function failingFinalExteriorKeys(findings) {
  const parsed = parseFindings(findings);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const failing = FINAL_EXTERIOR_TEXT_KEYS.filter((key) => {
    const value = String(parsed[key] ?? '').trim();
    return Boolean(value) && (customerCopyViolations(value).length > 0 || containsReportAccessCode(value));
  });
  const time = String(parsed.final_exterior_time ?? '').trim();
  if (time && !isClockTime(time)) failing.push('final_exterior_time');
  return failing;
}

// Copy of the findings with every failing final-exterior value blanked.
function screenFinalExteriorFindings(findings) {
  const failing = failingFinalExteriorKeys(findings);
  if (!failing.length) return findings;
  const out = { ...parseFindings(findings) };
  for (const key of failing) out[key] = '';
  return out;
}

module.exports = { FINAL_EXTERIOR_TEXT_KEYS, isClockTime, failingFinalExteriorKeys, screenFinalExteriorFindings };
