/**
 * Backfill irrigation_run_minutes from legacy schedule notes.
 *
 * Before the column existed, customers put their per-zone runtime where they
 * could: irrigation_schedule_notes free text ("Each zone runs 20min"). The
 * email sweep and report derivation read ONLY the structured column, so
 * without a backfill those customers — the very ones this feature exists to
 * fix — would keep receiving copy claiming their minutes are missing
 * (GH codex P1 on #3478).
 *
 * This copies the customer's OWN stated number, never a guess, and only when
 * it is unambiguous:
 *   - irrigation_run_minutes is still NULL (a structured entry always wins),
 *   - the notes match an explicit per-zone-runtime phrasing, and
 *   - the notes contain exactly ONE distinct minutes figure — two figures
 *     ("front zones 20 min, beds 45 min") mean per-zone schedules the single
 *     column cannot represent, so the row is left for the email ask instead.
 *   - 1–240 bounds (the column's validation range).
 *
 * down() is a deliberate no-op: after the backfill, customers can edit the
 * structured value in the portal, and rows set here are indistinguishable
 * from rows they typed — clearing either would destroy customer data. The
 * 20260825000000 down() dropping the column is the real rollback.
 */

const PER_ZONE_PATTERNS = [
  // "each zone runs 20min", "every zone gets about 25 minutes", "all zones run 15 min"
  /\b(?:each|every|all)\s+zones?\s+(?:runs?|gets?|waters?|goes)\s*(?:for\s+)?(?:about\s+|around\s+|approx\.?\s*|~\s*)?(\d{1,3})\s*min(?:ute)?s?\b/i,
  // "20 min per zone", "20 minutes/zone", "25 min each zone", "20 mins a zone"
  /\b(\d{1,3})\s*min(?:ute)?s?\s*(?:per|\/|each|a|every)\s*zone\b/i,
  // "zones run 20 minutes", "zones for 20 min"
  /\bzones?\s+(?:runs?|for)\s+(?:about\s+|around\s+|approx\.?\s*|~\s*)?(\d{1,3})\s*min(?:ute)?s?\b/i,
];

/**
 * @returns {number|null} the single unambiguous per-zone runtime the notes
 * state, or null when there is nothing certain enough to promote.
 */
function parseRunMinutesFromNotes(notes) {
  const text = String(notes || '');
  if (!text.trim()) return null;

  // (0) Qualified, negated, or disabled statements are not uniform active
  // runtimes: "NOT every zone runs 20 min", "except zone 3", "but it is
  // disabled", "off for the winter". Rejecting on the vocabulary alone is
  // deliberately overbroad — fail-closed, same rationale as the guards below.
  if (/\b(?:not|never|no longer|except|but|however|unless|only|disabled|broken|off|shut|used to|varies|sometimes|winter|summer|seasonal|testing|disconnected)\b/i.test(text)) return null;

  let matched = null;
  for (const re of PER_ZONE_PATTERNS) {
    const m = text.match(re);
    if (m) { matched = Number(m[1]); break; }
  }
  if (matched == null) return null;

  // Ambiguity guards — anything the single per-zone-minutes column cannot
  // faithfully represent declines to NULL for the email ask to collect:
  // (1) the notes must state a minutes figure exactly ONCE — two mentions of
  // the SAME value ("20 min at 4am and 20 min at 6pm") describe two daily
  // cycles, not one, so equality is not enough;
  const allMinuteFigures = [...text.matchAll(/(\d{1,3})\s*min(?:ute)?s?\b/gi)].map((m) => Number(m[1]));
  if (allMinuteFigures.length !== 1 || allMinuteFigures[0] !== matched) return null;
  // (2) a duration in any OTHER unit ("zone 3 runs 1 hour", "half an hour")
  // is a conflicting figure the minutes scan cannot see;
  if (/\b(?:\d+(?:\.\d+)?|an?|one|two|half)\s*(?:hour|hr)s?\b/i.test(text)) return null;
  // (3) ANY repetition vocabulary, regardless of surrounding phrasing —
  // "twice each watering day", "two cycles", "2x", "runs again in the
  // evening" all multiply the real volume beyond minutes × days. Declining
  // on the word alone is deliberately overbroad: the fail-closed cost is a
  // promotable row staying NULL for the email ask, never a wrong figure
  // driving watering advice.
  if (/\b(?:twice|thrice|(?:two|three|four|\d+)\s*(?:x|times)|\d+x|cycles?|start\s+times?|(?:second|2nd)\s+run|runs?\s+again|repeats?)\b/i.test(text)) return null;
  // (4) more than one time-of-day mention — "at 4am and 6pm", "morning and
  // evening", "AM & PM" — is multiple daily runs however it is phrased. One
  // mention ("Mon/Wed/Fri at 4am") is just a start time and stays fine.
  const timeMentions = text.match(/\b(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)|am|pm|morning|evening|night|noon|midday)\b/gi) || [];
  if (timeMentions.length > 1) return null;
  // (5) ALLOWLIST — the decisive guard. Blocklisting repetition phrasings is
  // an unbounded game ("runs again", "goes again", "pauses then…", …); free
  // text can always express a second cycle a new way. Instead, every word in
  // the note must belong to a small benign schedule vocabulary — any token
  // outside it (a verb we did not anticipate, an exception, a location
  // remark) declines the promotion. Fail-closed: the cost of declining a
  // promotable note is the email ask; the cost of promoting a wrong one is
  // bad watering advice.
  const BENIGN_WORDS = new Set([
    'each', 'every', 'all', 'zone', 'zones', 'run', 'runs', 'running', 'gets', 'get', 'waters', 'water', 'goes',
    'for', 'about', 'around', 'approx', 'min', 'mins', 'minute', 'minutes', 'per', 'a', 'an', 'the', 'and', 'on', 'at',
    'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    // NOTE: 'week'/'weekly' are deliberately ABSENT — "20 min per zone per
    // week" states a weekly total, not the per-watering-day minutes the
    // structured column means, and must decline.
    'am', 'pm', 'morning', 'early', 'day', 'days',
    'rain', 'sensor', 'starts', 'start', 'schedule', 'system', 'sprinkler', 'sprinklers', 'irrigation',
  ]);
  const tokens = (text.toLowerCase().match(/[a-z]+/g) || []);
  if (tokens.some((t) => !BENIGN_WORDS.has(t))) return null;
  // (6) NUMBER BUDGET — the allowlist admits words, but a bare clock value
  // ("at 4 and 6am") is all digits. The note may contain at most: the one
  // minutes figure, one zone count ("3 zones"), and one start time — any
  // number beyond that budget is an unaccounted quantity (a second start
  // time, a second cycle) and declines.
  const numberTokens = text.match(/\d+(?::\d{2})?/g) || [];
  let numberBudget = 1; // the minutes figure
  if (/\d+\s*zones?\b/i.test(text)) numberBudget += 1;
  if (timeMentions.some((t) => /\d/.test(t))) numberBudget += 1;
  if (numberTokens.length > numberBudget) return null;

  if (!Number.isInteger(matched) || matched < 1 || matched > 240) return null;
  return matched;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_preferences'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_run_minutes'))) return;
  if (!(await knex.schema.hasColumn('property_preferences', 'irrigation_schedule_notes'))) return;

  const rows = await knex('property_preferences')
    .whereNull('irrigation_run_minutes')
    .whereNotNull('irrigation_schedule_notes')
    .select('id', 'irrigation_schedule_notes');

  for (const row of rows) {
    const minutes = parseRunMinutesFromNotes(row.irrigation_schedule_notes);
    if (minutes == null) continue;
    // Guarded UPDATE: only lands if the column is STILL null, so a customer
    // entry racing the deploy window is never overwritten.
    await knex('property_preferences')
      .where({ id: row.id })
      .whereNull('irrigation_run_minutes')
      .update({ irrigation_run_minutes: minutes });
  }
};

exports.down = async function down() {
  // No-op by design — see header. Rows set here are indistinguishable from
  // customer-typed values; the column-drop migration is the real rollback.
};

exports.__private = { parseRunMinutesFromNotes, PER_ZONE_PATTERNS };
