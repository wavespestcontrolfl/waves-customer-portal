// How many stories a caller said the home has, for the phone price tool (get_pricing, relay-context.js) and the staff call-assist
// panel (live-call-assist.js). Pest for a home above 5,500 sq ft is priced on the footprint, the living area over the stories
// (owner 2026-11-26), so the count must be a real one: a number or a numeric string, kept in the website quote's bounds (1 to 3; a
// split level said as 1.5 stays 1.5). Anything else (true, a list, text, zero) is no count: the caller is asked again, and no
// price is stated on a guess.
function storyCount(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(3, n)) : null;
}

// A count from a web form body or a property record (a lead draft: lead-estimate-automation.js, lead-draft-measurements.js). Nobody
// can be asked again there, and a number outside the bounds is a wrong field, not a tall home: 12 read as a count priced a 12,000
// sq ft home as a 1,000 sq ft footprint. So it is a count only as a number or a numeric string from 1 to 3 (1.5 kept); anything
// else (12, 0.2, true, [2], text) is no count, and the draft treats the story count as unknown.
function statedStoryCount(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 && n <= 3 ? n : null;
}

module.exports = { storyCount, statedStoryCount };
