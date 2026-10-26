// Gate and access codes on the office schedule (GATE_SCHEDULE_ACCESS_CODES,
// owner ruling 2026-10-26): the list row, the Complete service header, the
// Details sheet and the desktop side panel. The lines come from the day
// feed's `propertyAlerts` — the same alerts the tech app's stop brief shows
// (server/services/nextstop-alerts.js compilePropertyAlerts) — so the two
// screens never disagree about which code a stop uses:
//   "Gate: 1234"                                the customer's own gate code
//   "<label>: #4821 (neighborhood)"             the neighborhood's code
//   "<label>: #2424 (neighborhood, confirm on site)"  not confirmed yet
//   "Yard: …", "Garage: …", "Lockbox: …"        the profile's other codes
// The server sets `scheduleAccessEnabled` on each row while the gate is on;
// without it nothing here draws.

const NEIGHBORHOOD_TAG = /\s\((neighborhood(?:, confirm on site)?)\)$/;
const PROFILE_KIND = { Yard: 'property_gate', Garage: 'garage', Lockbox: 'lockbox' };
// Short enough to read as a keypad code (mono digits); anything longer is
// directions ("Call box: dial 102") and reads as text.
const CODE_LIKE = /^[#*]?[A-Za-z0-9](?:[A-Za-z0-9 -]{0,12}[A-Za-z0-9])?[#*]?$/;

export function scheduleAccessOn(service) {
  return service?.scheduleAccessEnabled === true;
}

// One line per gate alert: { key, label, value, codeLike, kind, neighborhood,
// unconfirmed, entryId, entryCode, reportedWrong }. `kind` is the access-code
// kind the line stands for (for the dedupe against accepted codes).
export function accessLinesOf(service) {
  if (!scheduleAccessOn(service)) return [];
  const alerts = Array.isArray(service.propertyAlerts) ? service.propertyAlerts : [];
  const seen = new Set();
  const lines = [];
  for (const alert of alerts) {
    if (!alert || alert.type !== 'gate' || typeof alert.text !== 'string') continue;
    const at = alert.text.indexOf(': ');
    if (at < 1) continue;
    const label = alert.text.slice(0, at).trim();
    let value = alert.text.slice(at + 2);
    const tag = value.match(NEIGHBORHOOD_TAG);
    if (tag) value = value.slice(0, tag.index);
    value = value.trim();
    if (!value || seen.has(alert.text)) continue;
    seen.add(alert.text);
    lines.push({
      key: alert.text,
      label,
      value,
      codeLike: CODE_LIKE.test(value),
      kind: tag ? 'neighborhood_gate' : (PROFILE_KIND[label] || 'neighborhood_gate'),
      neighborhood: !!tag,
      unconfirmed: !!tag && tag[1] !== 'neighborhood',
      entryId: alert.neighborhoodEntryId || null,
      entryCode: alert.neighborhoodEntryCode || null,
      reportedWrong: alert.reportedWrong === true,
    });
  }
  return lines;
}

export const ACCESS_KIND_LABELS = {
  neighborhood_gate: 'Neighborhood gate',
  property_gate: 'Yard gate',
  door: 'Door or lock',
  lockbox: 'Lockbox',
  garage: 'Garage',
  call_box: 'Call box',
  pass: 'Visitor pass',
  other: 'Access code',
};

// Codes the office accepted (GET /admin/access-codes/visits/:id) that this
// stop needs and the lines above do not already show: standing codes and
// one-visit codes for this visit. A row is hidden only when a line shows the
// same code for the same access point, the rule the tech app uses; codes
// compare as the server compares them (case and spaces ignored).
export function acceptedRowsFor(service, rows, lines) {
  const canon = (c) => String(c || '').replace(/\s+/g, '').toLowerCase();
  const shown = new Set(lines.map((l) => `${l.kind}:${canon(l.value)}`));
  return (Array.isArray(rows) ? rows : []).filter((r) => r
    && (r.life === 'standing' || String(r.scheduledServiceId) === String(service?.id))
    && (r.code || r.instructions)
    && !(r.code && !r.instructions && shown.has(`${r.kind}:${canon(r.code)}`)));
}
