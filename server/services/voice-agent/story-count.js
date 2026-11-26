// How many stories a caller said the home has, for the phone price tool (get_pricing, relay-context.js) and the staff call-assist
// panel (live-call-assist.js). Pest for a home above 5,500 sq ft is priced on the footprint, the living area over the stories
// (owner 2026-11-26), so the count must be a real one: a number or a numeric string, kept in the website quote's bounds (1 to 3; a
// split level said as 1.5 stays 1.5). Anything else (true, a list, text, zero) is no count: the caller is asked again, and no
// price is stated on a guess.
function storyCount(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(3, n)) : null;
}

module.exports = { storyCount };
