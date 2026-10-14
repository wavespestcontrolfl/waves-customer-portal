// The fertilizer safety block of the v13 lawn program (owner 2026-10-06), in ONE place. A staged
// protocol row that carries gates.fertilizerSafety = true (every N-carrying spreader row, migration
// 20261007159000) makes its window an N visit; the job card procedure and the wiki-synced SOP both
// print this block for such a window, and say nothing for a window with no such row (hose visits).
// The recipe file keeps its own short track-level lines for the reference tab.
const FERTILIZER_SAFETY_GATE = 'fertilizerSafety';

const FERTILIZER_SAFETY_RULES = [
  'Use the deflector shield on the rotary spreader.',
  'Keep a 10 ft fertilizer-free band from any water body, wetland, seawall or top of bank.',
  'Do not fertilize when a severe thunderstorm, flood or tropical watch or warning is forecast.',
  'Sweep fertilizer off driveways, sidewalks and streets back onto the lawn.',
  'Keep the Manatee BMP decal on the vehicle.',
];

function gatesOf(row) {
  const gates = row?.gates;
  if (typeof gates === 'string') {
    try { return JSON.parse(gates) || {}; } catch { return {}; }
  }
  return gates && typeof gates === 'object' ? gates : {};
}

// The block for a window's protocol rows: the rules when any row is gated, else none.
function fertilizerSafetyRules(rows) {
  return (rows || []).some((row) => gatesOf(row)[FERTILIZER_SAFETY_GATE] === true) ? FERTILIZER_SAFETY_RULES : [];
}

module.exports = { FERTILIZER_SAFETY_GATE, FERTILIZER_SAFETY_RULES, fertilizerSafetyRules };
