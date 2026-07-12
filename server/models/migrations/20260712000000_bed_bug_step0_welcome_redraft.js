/**
 * Redrafts the bed_bug automation's step-0 from a prep guide into a
 * welcome / what-to-expect email, and moves it to a 2-hour delay
 * (estimate_sent precedent — a follow-up, not a booking-instant blast).
 *
 * Why: #2635 wires first-time bed bug bookings to auto-enroll this
 * sequence, and the booking already sends the transactional prep guide
 * (prep.bed_bug + companion SMS). With the old copy, a first-time
 * customer got two near-duplicate prep emails. The sequence email now
 * complements the guide (treatment day, the 14-day follow-up, what
 * results look like) and points back to the emailed prep guide instead
 * of repeating it.
 *
 * Admin-edit safe: the update only applies while the row still carries
 * the VERBATIM 20260424000007 seed copy (verified against prod
 * 2026-07-11: md5 92039295bc39f25db3ffbe269c63a58a, untouched since
 * seed day). An operator-edited row is left alone.
 */

const BRAND_FOOTER = `
<p>— The Waves Pest Control team</p>
<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>`;

// Verbatim 20260424000007 seed copy — the guard fingerprint.
const SEED_SUBJECT = 'Your bed bug treatment prep guide';
const SEED_HTML = `<h2>Hi {{first_name}} — let's get your home bed bug-free</h2>
<p>Bed bug treatments work best when the home is prepped properly. This list isn't optional — skipping steps is the #1 reason a treatment needs a follow-up.</p>

<h2>Before we arrive</h2>
<ul>
  <li>Strip all bedding — sheets, pillowcases, comforters. Wash hot, dry hot for 30+ minutes.</li>
  <li>Vacuum mattresses, box springs, and the floor along baseboards. Empty the vacuum outside.</li>
  <li>Clear the floor of clutter (clothes, shoes, toys) in the affected rooms</li>
  <li>Pull furniture 12–18 inches from the walls</li>
  <li>Bag clean laundry in sealed plastic bags until the treatment is complete</li>
</ul>

<h2>Day of treatment</h2>
<p>Plan to be out of the home for 3–4 hours. Pets too — including fish tanks covered and pumps off for the duration.</p>

<h2>After</h2>
<p>We'll schedule a follow-up visit at 14 days to catch any eggs that hatched post-treatment. Don't re-wash bedding until after that second visit.</p>

<p>Reply to this email if anything on the list is unclear — we'd rather answer now than re-treat later.</p>
${BRAND_FOOTER}`;
const SEED_TEXT = 'Hi {{first_name}} — let\'s get your home bed bug-free. Before we arrive: strip bedding (hot wash + hot dry 30+ min), vacuum mattresses/box springs/baseboards and empty the vacuum outside, clear floor clutter, pull furniture 12–18" from walls, bag clean laundry until treatment is done. Day of: be out 3–4 hours, pets too. Follow-up visit in 14 days. — The Waves Pest Control team';
const SEED_PREVIEW = 'Follow this checklist so the first treatment works the first time.';
const SEED_DELAY_HOURS = 0;

const NEW_SUBJECT = 'What to expect from your bed bug treatment, {{first_name}}';
const NEW_PREVIEW = 'How treatment day goes, the 14-day follow-up, and what results look like.';
const NEW_HTML = `<h2>Hi {{first_name}} — we've got you</h2>
<p>Bed bugs are one of the most stressful pests to deal with, and also one we treat all the time. Here's how the process goes so nothing surprises you.</p>

<h2>Before your visit</h2>
<p>Your prep guide is in a separate email — it's the single biggest factor in getting results the first time, so please work through that checklist before we arrive. If anything on it is unclear, just reply here.</p>

<h2>Treatment day</h2>
<p>Plan to be out of the home for a few hours, pets included. Your technician will treat the affected rooms and the places bed bugs hide — mattresses, frames, baseboards, and furniture seams.</p>

<h2>The two weeks after</h2>
<p>Seeing some activity in the days after treatment is normal — eggs that were already laid can still hatch. That's exactly why we schedule a follow-up visit at 14 days: it catches that next wave and breaks the cycle. Hold off on re-washing bedding until after that second visit.</p>

<p>Questions at any point — before, during, or after — just reply to this email. It goes straight to our team, no ticket queue.</p>
${BRAND_FOOTER}`;
const NEW_TEXT = 'Hi {{first_name}} — bed bugs are stressful, and we treat them all the time. Your prep guide is in a separate email — working through that checklist is the biggest factor in first-time results. Treatment day: plan to be out of the home for a few hours, pets included. Some activity in the days after treatment is normal (already-laid eggs can hatch) — that\'s why we schedule a 14-day follow-up visit; hold off re-washing bedding until after it. Questions anytime, just reply. — The Waves Pest Control team';
const NEW_DELAY_HOURS = 2;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;

  const row = await knex('automation_steps').where({ template_key: 'bed_bug', step_order: 0 }).first();
  if (!row) return;
  // Preserve operator edits: only replace the verbatim seed copy.
  if (row.subject !== SEED_SUBJECT || row.html_body !== SEED_HTML) return;

  await knex('automation_steps').where({ id: row.id }).update({
    subject: NEW_SUBJECT,
    preview_text: NEW_PREVIEW,
    html_body: NEW_HTML,
    text_body: NEW_TEXT,
    delay_hours: NEW_DELAY_HOURS,
    updated_at: new Date(),
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('automation_steps'))) return;

  const row = await knex('automation_steps').where({ template_key: 'bed_bug', step_order: 0 }).first();
  if (!row) return;
  if (row.subject !== NEW_SUBJECT || row.html_body !== NEW_HTML) return;

  await knex('automation_steps').where({ id: row.id }).update({
    subject: SEED_SUBJECT,
    preview_text: SEED_PREVIEW,
    html_body: SEED_HTML,
    text_body: SEED_TEXT,
    delay_hours: SEED_DELAY_HOURS,
    updated_at: new Date(),
  });
};
