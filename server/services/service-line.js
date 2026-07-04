// Canonical service-type → service-line classifier, shared by the revenue
// routes, the revenue Intelligence-Bar tools, and the dashboard's
// margin-by-line card. Extracted from admin-revenue.js (Phase 5) — the copy in
// intelligence-bar/revenue-tools.js had already drifted (it lacked the
// One-Time branch), which is exactly why this lives in one place now.
function classifyServiceLine(type) {
  const t = (type || '').toLowerCase();
  // "turf": commercial lawn persists as "Commercial Turf Treatment Program"
  if (t.includes('lawn') || t.includes('turf')) return 'Lawn Care';
  if (t.includes('mosquito')) return 'Mosquito';
  if (t.includes('tree') || t.includes('shrub')) return 'Tree & Shrub';
  if (t.includes('termite')) return 'Termite';
  if (t.includes('rodent')) return 'Rodent';
  if (t.includes('one-time') || t.includes('one time')) return 'One-Time';
  return 'Pest Control';
}

module.exports = { classifyServiceLine };
