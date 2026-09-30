// =========================================================================
// Fixed, client-owned copy + config for the lawn / tree-shrub / palm Photo
// ID workup (L5 — renders only when the server sends `data.v2.kind ===
// "workup"`, per PLANT-ENGINE-CONTRACT.md §6.7, and the subject chips /
// guided shots per lawn-ts-photo-id-scope-20260927.md §5).
//
// Everything exported here is either:
//   - a client-side question label / chip config for the capture flow
//     (never sent to the customer as a "finding" — these are OUR questions), or
//   - one of the small set of FIXED section headings / phrase templates the
//     scope and contract name explicitly for the workup card.
// Every other string the workup card renders is payload text from the
// server's `v2` object, rendered verbatim — never composed here.
// =========================================================================

// The type picker's subject value is what the sheet tracks as `selectedType`
// (pest | lawn | tree_shrub | palm). `palm` is its own subject (scope §5,
// decision 7) but still POSTs to the existing `/api/photo-id/tree_shrub`
// route — there is no `/api/photo-id/palm` endpoint.
export const SUBJECT_ROUTE_TYPE = { pest: 'pest', lawn: 'lawn', tree_shrub: 'tree_shrub', palm: 'tree_shrub' };

// The `subject` field sent in the POST body for the plant engine (contract
// §2: 'lawn' | 'tree_shrub' | 'palm'). Pest carries no subject field.
export const SUBJECT_BODY_VALUE = { lawn: 'lawn', tree_shrub: 'tree_shrub', palm: 'palm' };

// Guided three shots (scope §5 table) — role hints shown above the photo
// slots. Capture mechanics (camera hand-off, HEIC transcode, retake) are
// unchanged; these are labels only, not separate upload slots.
export const GUIDED_SHOT_LABELS = {
  lawn: [
    'The whole affected area from standing height, with a landmark',
    'The edge where bad meets good, from about 3 feet away',
    'A blade or a pulled-up plug (roots and thatch), close, next to a coin',
  ],
  tree_shrub: [
    'The whole plant',
    'A leaf, top side, in the shade of your hand',
    'The leaf underside or the stem/bark where it looks wrong',
  ],
  palm: [
    'The whole palm',
    'The oldest (lowest) fronds',
    'The newest fronds and the spear at the top; the trunk base if anything looks soft, cracked, or has a shelf growing on it',
  ],
};

// A tap on "Not sure" either sends the literal `not_sure` enum value (only
// where the engine's own chip enum has one — recent_application) or omits
// the key entirely (every other question — the engine treats missing chips
// the same as "not sure": "chips … all optional … unknown keys ignored").
export const NOT_SURE_VALUE = '__not_sure__';
export const NOT_SURE_LABEL = 'Not sure';

// type: 'string' (sent as-is) | 'number' (Number(value)) | 'boolean'
// ('true'/'false' strings -> JS boolean) — matches the JSON types in the
// contract's §6.7 example (`watering_days: 3`, `spreading: true`).
export const CHIP_QUESTIONS = {
  lawn: [
    {
      key: 'watering_days', type: 'number', label: 'Watering, days per week', notSureValue: null,
      options: [
        { value: '0', label: '0 days' },
        { value: '1', label: '1 day' },
        { value: '2', label: '2 days' },
        { value: '3', label: '3+ days' },
      ],
    },
    {
      key: 'recent_application', type: 'string', label: 'Anything applied in the last 2 weeks, by anyone', notSureValue: 'not_sure',
      options: [
        { value: 'fertilizer', label: 'Fertilizer' },
        { value: 'weed_control', label: 'Weed control' },
        { value: 'insect_control', label: 'Insect control' },
        { value: 'none', label: 'None' },
      ],
    },
    {
      key: 'onset', type: 'string', label: 'When did it start', notSureValue: null,
      options: [
        { value: 'days', label: 'Days' },
        { value: 'weeks', label: 'Weeks' },
        { value: 'months', label: 'Months' },
      ],
    },
    {
      key: 'spreading', type: 'boolean', label: 'Is it spreading', notSureValue: null,
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    },
    {
      key: 'light', type: 'string', label: 'Light', notSureValue: null,
      options: [
        { value: 'full_sun', label: 'Full sun' },
        { value: 'part_shade', label: 'Part shade' },
        { value: 'shade', label: 'Shade' },
      ],
    },
    {
      key: 'pets', type: 'boolean', label: 'Do pets use this area', notSureValue: null,
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    },
    // No `grass_type` chip: PhotoIdSheet has no client-side signal for the
    // account's grass type on file (that lives server-side in
    // lawn-grass-context.js and is never passed down into this component
    // today), so per the scope's own fallback ("or omit the chip if it
    // cannot") the chip is omitted entirely rather than asking a customer
    // whose grass type IS on file to re-enter it, or guessing at a UI-only
    // "on file" signal. See the PR body for this decision.
  ],
  tree_shrub: [
    {
      key: 'watering', type: 'string', label: 'Watering', notSureValue: null,
      options: [
        { value: 'irrigation', label: 'Irrigation' },
        { value: 'hand', label: 'By hand' },
        { value: 'rain', label: 'Rain only' },
      ],
    },
    {
      key: 'recently_planted', type: 'boolean', label: 'Recently planted (under 6 months)', notSureValue: null,
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    },
    {
      key: 'where_started', type: 'string', label: 'Where it started', notSureValue: null,
      options: [
        { value: 'whole', label: 'Whole plant' },
        { value: 'one_side', label: 'One side' },
        { value: 'lower', label: 'Lower' },
        { value: 'top', label: 'Top' },
      ],
    },
  ],
  palm: [
    {
      key: 'fronds', type: 'string', label: 'Which fronds', notSureValue: null,
      options: [
        { value: 'oldest', label: 'Oldest' },
        { value: 'newest', label: 'Newest' },
        { value: 'all', label: 'All' },
        { value: 'spear', label: 'The spear' },
      ],
    },
    {
      key: 'recently_planted', type: 'boolean', label: 'Recently planted (under 6 months)', notSureValue: null,
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    },
    {
      key: 'fruit_dropping', type: 'boolean', label: 'Fruit dropping early', notSureValue: null,
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    },
  ],
};

const PLANT_NAME_LIMIT = 80;

// Converts this session's tap answers into the engine's `chips` object.
// Unanswered / "not sure with no enum value" questions are simply left out
// — "chips … may be {}", "unknown keys ignored" (contract §2/§3).
export function buildChipsPayload(subject, answers = {}) {
  const questions = CHIP_QUESTIONS[subject] || [];
  const chips = {};
  for (const q of questions) {
    const raw = answers[q.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (raw === NOT_SURE_VALUE) {
      if (q.notSureValue) chips[q.key] = q.notSureValue;
      continue;
    }
    if (q.type === 'number') chips[q.key] = Number(raw);
    else if (q.type === 'boolean') chips[q.key] = raw === 'true';
    else chips[q.key] = raw;
  }
  if (subject === 'tree_shrub' || subject === 'palm') {
    // No search over a small local list yet (scope §5 / assignment): the
    // customer types a free plant name instead. `plant_slug` stays null —
    // never guessed from the free-text name — and `plant_name` is an extra
    // key the engine's chip parser ignores today (contract: "unknown keys
    // ignored"), carried along so a later PR can read it once search lands.
    chips.plant_slug = null;
    const name = String(answers.plant_name || '').trim().slice(0, PLANT_NAME_LIMIT);
    if (name) chips.plant_name = name;
  }
  return chips;
}

export { PLANT_NAME_LIMIT };

// ---- Workup card fixed copy (PLANT-ENGINE-CONTRACT.md §6.2, §6.5) --------

export const LOCAL_FIT_LABELS = {
  peak_season: 'Peak season',
  fits_watering: 'Fits your watering',
  fits_application: 'Fits a recent application',
  fits_light: 'Fits the light',
  fits_new_planting: 'Fits a new planting',
  fits_fronds: 'Fits which fronds',
};

// Outcome chip: only ever rendered for these two outcomes (§6.7 rule 4 /
// scope §11 no-cure honesty) — every other outcome value renders no chip.
export const OUTCOME_CHIP_LABEL = { no_cure: 'Cannot be cured', regulated: 'Regulated' };

// subject.weeds[].wording -> the phrase used in "Also spotted: {name} — {phrase}".
export const WEED_WORDING_PHRASE = { pretty_sure: "we're pretty sure", likely: 'likely' };

export const FIELD_TEST_TECHNICIAN_LINE = 'or a technician checks it on your next visit.';

// The workup's named subject plant (Codex #5250 r4): the grass on file for
// the account, or the plant the photo named, with the photo's wording.
export function subjectPlantChipText(plant, subjectType) {
  const noun = subjectType === 'lawn' ? 'Grass' : 'Plant';
  if (plant.source === 'account') return `${noun} on file: ${plant.common_name}`;
  const phrase = WEED_WORDING_PHRASE[plant.wording];
  return `${noun}: ${plant.common_name}${phrase ? ` — ${phrase}` : ''}`;
}

// evidence.chips readable phrases (assignment: "Evidence we have (photo
// count + chips as readable phrases)"). Only chip keys/values this table
// defines are ever rendered — an unrecognized key or value is skipped
// rather than guessed at.
export const EVIDENCE_CHIP_PHRASES = {
  watering_days: { 0: 'Not watered', 1: 'Watered 1 day/week', 2: 'Watered 2 days/week', 3: 'Watered 3+ days/week' },
  recent_application: {
    fertilizer: 'Fertilizer applied in the last 2 weeks',
    weed_control: 'Weed control applied in the last 2 weeks',
    insect_control: 'Insect control applied in the last 2 weeks',
    none: 'No application in the last 2 weeks',
    not_sure: 'Not sure about a recent application',
  },
  onset: { days: 'Started days ago', weeks: 'Started weeks ago', months: 'Started months ago' },
  spreading: { true: 'Spreading', false: 'Not spreading' },
  light: { full_sun: 'Full sun', part_shade: 'Part shade', shade: 'Shade' },
  pets: { true: 'Pets use this area', false: "Pets don't use this area" },
  watering: { irrigation: 'Watered by irrigation', hand: 'Watered by hand', rain: 'Watered by rain only' },
  recently_planted: { true: 'Recently planted', false: 'Not recently planted' },
  where_started: { whole: 'Started over the whole plant', one_side: 'Started on one side', lower: 'Started low', top: 'Started at the top' },
  fronds: { oldest: 'Oldest fronds', newest: 'Newest fronds', all: 'All fronds', spear: 'The spear' },
  fruit_dropping: { true: 'Fruit dropping early', false: 'No early fruit drop' },
};

export function evidenceChipPhrase(key, value) {
  const table = EVIDENCE_CHIP_PHRASES[key];
  if (!table) return null;
  const phrase = table[value];
  return phrase || null;
}
