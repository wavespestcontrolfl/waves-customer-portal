// Open schedule-change cards written before the ISO days existed carry only
// their display text ("Thu Dec 10, 2–3 PM"). The Today page decides "today or
// tomorrow" from payload.date / payload.previous_date, so an old move OFF
// today would fold into the summary (Codex #5786 P2). This fills both days
// from the text on undismissed visit_* cards that lack them, choosing each
// day's year as the one nearest the card's own creation (moves land within
// the scheduling lookahead).
//
// down() is a documented no-op: the added keys are additive and readers treat
// their absence as "fall back to the visit's day", so leaving them is harmless
// and removing them could strip days a later writer set.
const TYPES = ['visit_assigned', 'visit_unassigned', 'visit_rescheduled', 'visit_cancelled'];
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// "Thu Dec 10, 2–3 PM" / "Thu Dec 10" → the ISO day nearest `createdAt`.
function dayFrom(text, createdAt) {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2})\b/.exec(String(text || ''));
  if (!m || MONTHS[m[1]] === undefined) return null;
  const month = MONTHS[m[1]];
  const day = Number(m[2]);
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const year = created.getUTCFullYear();
  let best = null;
  for (const y of [year - 1, year, year + 1]) {
    const at = Date.UTC(y, month, day, 12);
    if (new Date(at).getUTCDate() !== day) continue;
    const gap = Math.abs(at - created.getTime());
    if (!best || gap < best.gap) best = { gap, value: iso(y, month, day) };
  }
  return best && best.gap < 200 * DAY_MS ? best.value : null;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('tech_notifications'))) return;
  const rows = await knex('tech_notifications')
    .whereNull('dismissed_at')
    .whereIn('type', TYPES)
    .whereRaw("payload->>'date' IS NULL")
    .select('id', 'type', 'payload', 'created_at');
  for (const row of rows) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
    const date = dayFrom(payload.when, row.created_at);
    const previousDate = row.type === 'visit_rescheduled' ? dayFrom(payload.previous_when, row.created_at) : null;
    if (!date && !previousDate) continue;
    await knex('tech_notifications')
      .where({ id: row.id })
      .update({ payload: knex.raw('payload || ?::jsonb', [JSON.stringify({ date, previous_date: previousDate })]) });
  }
};

exports.down = async function down() {
  // Documented no-op (see header).
};

exports._test = { dayFrom };
