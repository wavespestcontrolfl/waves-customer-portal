/**
 * Address key: street directionals and more suffix short forms (ops review
 * 2026-11-02).
 *
 * addressKey now expands street DIRECTIONALS ("Ave E" == "Avenue East",
 * "Dr NE" == "Drive Northeast") and more suffix forms ("Lp" == "Loop",
 * "Grv Wy" == "Grove Way", plus the USPS Pub 28 forms). Only STREET words
 * expand: a unit id stays exact ("Apt E" != "Apt East"), and nothing is ever
 * stripped ("Main St" != "Main Ave"). Under the old key an estimate accept, a
 * booked call or an admin entry that spelled a house the other way minted a
 * second customer_properties row, and visits and estimates split across the
 * two. Same shape as 20261002090000, which this follows.
 *
 * In ONE transaction, holding every table it reads or writes under a lock:
 *   1. folds, per customer, the active rows that share a new key into one
 *      keeper (the primary, else the oldest row): each property_id
 *      reference moves to the keeper (a reference the keeper already holds
 *      under a unique index stays on the retired copy as history) and the
 *      copy is retired (active = false, is_primary = false);
 *   2. rewrites every stored customer_properties.address_key;
 *   3. rewrites saved service-area measurements, which carry the key they
 *      were saved under, and the open property-role cards (triage_items
 *      'property_role_confirm'), whose staged proposals carry keys and ids;
 *   4. rewrites the other stored copies of a customer key: the customer home
 *      line stamp (customers.home_line_address_key, which a staff pick relies
 *      on to hold) and the Manatee pool-permit exact key
 *      (pool_permit_records.address_key). Each is moved only while it still
 *      equals the OLD key of its own address, in a compare-and-set update, so
 *      a row staff or a sync changed since is left alone.
 *
 * Reference tables (information_schema, 2026-11-02): the 10-02 list plus
 * customer_access_codes, lawn_trouble_areas, misting_calibrations,
 * misting_refills and property_application_history. Left on a retired copy as
 * history, on purpose:
 *   - field_credit_allocations: its field_program_immutable trigger refuses
 *     any UPDATE;
 *   - portal_chat_requests: a retry receipt whose scope_key and conversation
 *     id hash the property id the client sent, so re-pointing the row would
 *     make that client's retry read as a different request.
 * None of the moved tables has a trigger on property_id. The scheduled_services
 * triggers fire only on date / window / status. Moving a property_id sends no
 * customer communication, and neither does any other write here.
 *
 * The lock (SHARE ROW EXCLUSIVE: reads continue, writes wait) is taken before
 * the first read, with lock_timeout, so the migration (and the deploy) fails
 * rather than queueing behind a long transaction.
 *
 * The old and new key functions are FROZEN copies, so this migration does the
 * same thing whenever it runs. A test pins the old copy to the 2026-10-02 key
 * and the new copy to the live addressKey; a later change to addressKey needs
 * its own migration.
 *
 * down(), from its system_settings state row, restores old-format keys (from
 * each row's current address), reactivates the retired copies, puts
 * measurement keys back, restores role cards nobody touched since and puts the
 * home line and permit keys back. Moved references and copied facts stay on
 * the keeper (same house).
 */

const STATE_KEY = 'migration.20261102130000.state';

// ── Frozen key functions ─────────────────────────────────────────────────
const normStreet = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normalizeZip = (z) => (String(z || '').match(/\d{5}/) || [''])[0];
const stripUnitDesignators = (s) => String(s || '')
  .replace(/[.,#]/g, ' ')
  .replace(/\b(?:apt|apartment|unit|ste|suite)\b\.?/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const unitKey = (s) => normStreet(stripUnitDesignators(s));

// The suffix map as it stood on 2026-11-02, before this migration.
const OLD_SUFFIX = {
  st: 'street', street: 'street', ave: 'avenue', avenue: 'avenue', rd: 'road', road: 'road',
  dr: 'drive', drive: 'drive', ln: 'lane', lane: 'lane', ct: 'court', court: 'court',
  blvd: 'boulevard', boulevard: 'boulevard', cir: 'circle', circle: 'circle',
  pl: 'place', place: 'place', ter: 'terrace', terrace: 'terrace', way: 'way',
  trl: 'trail', trail: 'trail', pkwy: 'parkway', parkway: 'parkway', hwy: 'highway', highway: 'highway',
  gln: 'glen', glen: 'glen', cv: 'cove', cove: 'cove', trce: 'trace', trace: 'trace',
  xing: 'crossing', crossing: 'crossing', lndg: 'landing', landing: 'landing',
  rdg: 'ridge', ridge: 'ridge', crk: 'creek', creek: 'creek', holw: 'hollow', hollow: 'hollow',
  sq: 'square', square: 'square', bnd: 'bend', bend: 'bend', aly: 'alley', alley: 'alley',
  vw: 'view', view: 'view', vis: 'vista', vista: 'vista', cswy: 'causeway', causeway: 'causeway',
  plz: 'plaza', plaza: 'plaza', pt: 'point', point: 'point', mdw: 'meadow', meadow: 'meadow',
  mdws: 'meadows', meadows: 'meadows', hts: 'heights', heights: 'heights', psge: 'passage', passage: 'passage',
};
const NEW_SUFFIX = {
  ...OLD_SUFFIX,
  lp: 'loop', loop: 'loop', grv: 'grove', grove: 'grove', wy: 'way',
  cres: 'crescent', crescent: 'crescent', crst: 'crest', crest: 'crest', cmn: 'common', common: 'common',
  gdn: 'garden', garden: 'garden', gdns: 'gardens', gardens: 'gardens', grn: 'green', green: 'green',
  hbr: 'harbor', harbor: 'harbor', hl: 'hill', hill: 'hill', hls: 'hills', hills: 'hills', isle: 'isle',
  knl: 'knoll', knoll: 'knoll', lk: 'lake', lake: 'lake', lks: 'lakes', lakes: 'lakes', mnr: 'manor', manor: 'manor',
  orch: 'orchard', orchard: 'orchard', pnes: 'pines', pines: 'pines', rnch: 'ranch', ranch: 'ranch',
  shr: 'shore', shore: 'shore', shrs: 'shores', shores: 'shores', spg: 'spring', spring: 'spring',
  spgs: 'springs', springs: 'springs', vlg: 'village', village: 'village', vly: 'valley', valley: 'valley',
  ests: 'estates', estates: 'estates', frst: 'forest', forest: 'forest', bch: 'beach', beach: 'beach',
  blf: 'bluff', bluff: 'bluff', brk: 'brook', brook: 'brook',
};
const DIRECTIONAL = {
  n: 'north', s: 'south', e: 'east', w: 'west', ne: 'northeast', nw: 'northwest', se: 'southeast', sw: 'southwest',
};
const UNIT_DESIGNATOR_WORDS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', '#']);

const canonical = (map) => (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ')
  .split(/\s+/).map((w) => map[w] || w).join(' ');
// Suffixes AND directionals; the token right after a unit designator stays exact.
const canonicalScope = (s) => {
  const words = String(s || '').toLowerCase().replace(/[.,]/g, ' ').replace(/#/g, ' # ').split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    const canon = NEW_SUFFIX[w] || w;
    return UNIT_DESIGNATOR_WORDS.has(words[i - 1]) ? canon : (DIRECTIONAL[canon] || canon);
  }).join(' ');
};

const stripTrailingUnit = (s) => String(s || '').replace(/\s+(?:apt|apartment|unit|ste|suite|#)\.?\s*[a-z0-9-]+\s*$/i, '').trim();
const INLINE_UNIT_TAIL_RE = /\s(?:(?:apt|apartment|unit|ste|suite)\b|#)\s*(\S.*)$/i;

function keyWith(streetOf) {
  return ({ address_line1, address_line2, city, zip } = {}) => {
    const line1 = String(address_line1 || '').replace(/[.,]/g, ' ').replace(/#/g, ' #').replace(/\s+/g, ' ').trim();
    const inline = line1.match(INLINE_UNIT_TAIL_RE);
    const street = streetOf(stripTrailingUnit(inline ? line1.slice(0, inline.index) : line1)).replace(/[^a-z0-9]/g, '');
    const embedded = inline ? unitKey(inline[1]) : '';
    const line2 = unitKey(address_line2);
    const unit = embedded && line2 && embedded !== line2 ? `${embedded}${line2}` : (embedded || line2);
    const locality = normalizeZip(zip) || normStreet(city);
    return `${street}${unit}${locality}`;
  };
}

/** customer-properties addressKey as it was before this migration (2026-10-02 format; pinned by a test). */
const oldKey = keyWith(canonical(OLD_SUFFIX));
/** customer-properties addressKey from 2026-11-02 (pinned to the live helper by a test). */
const newKey = keyWith(canonicalScope);

// ── Tables ──────────────────────────────────────────────────────────────
// See the header for the two tables left out. Tables or columns missing in an
// environment are skipped.
const REFERENCE_TABLES = [
  'scheduled_services', 'estimates', 'lawn_assessments', 'lawn_baseline_resets',
  'lawn_protocol_service_completions', 'visual_service_moments', 'lawn_diagnostics',
  'tree_shrub_assessments', 'pest_identifications', 'service_visits',
  'property_notification_prefs', 'property_text_decisions',
  'photo_id_issues', 'visit_prep_submissions',
  'customer_access_codes', 'lawn_trouble_areas', 'misting_calibrations', 'misting_refills',
  'property_application_history',
];
const ROLE_CARD = 'property_role_confirm';
const OPEN_CARD_STATUSES = ['open', 'in_progress', 'snoozed'];
const ADDRESS_COLS = ['id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip', 'address_key', 'active', 'is_primary', 'created_at'];

async function referenceTables(knex) {
  const out = [];
  for (const table of REFERENCE_TABLES) {
    if ((await knex.schema.hasTable(table)) && (await knex.schema.hasColumn(table, 'property_id'))) out.push(table);
  }
  return out;
}

async function lockTables(knex, tables, hasTriage) {
  const locked = ['customer_properties', ...tables, ...(hasTriage ? ['triage_items'] : [])];
  await knex.raw("SET LOCAL lock_timeout = '20s'");
  await knex.raw(`LOCK TABLE ${locked.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Property-level facts a retired copy may hold that its keeper lacks. Fill
// only: the keeper's own value always wins a conflict. Coordinates move as a
// pair; reviewed measurements only onto a keeper with none whose sizes the
// measurements were reviewed against (property-service-areas reviewedAreas).
const FILL_FIELDS = ['label', 'relationship', 'property_type', 'lawn_type', 'property_sqft', 'lot_sqft',
  'bed_sqft', 'linear_ft_perimeter', 'palm_count', 'canopy_type'];
const blank = (v) => v === null || v === undefined || v === '';
const hasAreas = (m) => !!(m && typeof m === 'object' && m.areas && Object.keys(m.areas).length);

function factsPatch(keeper, loser, cols) {
  const patch = {};
  for (const f of FILL_FIELDS) if (cols.has(f) && blank(keeper[f]) && !blank(loser[f])) patch[f] = loser[f];
  if (cols.has('occupancy_type') && (blank(keeper.occupancy_type) || keeper.occupancy_type === 'unknown')
    && !blank(loser.occupancy_type) && loser.occupancy_type !== 'unknown') patch.occupancy_type = loser.occupancy_type;
  if (cols.has('latitude') && blank(keeper.latitude) && blank(keeper.longitude) && !blank(loser.latitude) && !blank(loser.longitude)) {
    patch.latitude = loser.latitude;
    patch.longitude = loser.longitude;
  }
  return patch;
}

function measurementsPatch(keeper, loser, patch, cols) {
  if (!cols.has('service_area_measurements')) return null;
  const km = parse(keeper.service_area_measurements);
  const lm = parse(loser.service_area_measurements);
  const after = { ...keeper, ...patch };
  if (hasAreas(km) || !hasAreas(lm) || lm.addressKey !== oldKey(loser)) return null;
  if ((after.bed_sqft ?? null) !== (loser.bed_sqft ?? null) || (after.property_sqft ?? null) !== (loser.property_sqft ?? null)) return null;
  return JSON.stringify({ ...lm, addressKey: newKey(keeper) });
}

async function fillKeeper(knex, keeperId, loserId, cols, state) {
  const [keeper, loser] = await Promise.all([
    knex('customer_properties').where({ id: keeperId }).first(),
    knex('customer_properties').where({ id: loserId }).first(),
  ]);
  if (!keeper || !loser) return;
  const patch = factsPatch(keeper, loser, cols);
  const measurements = measurementsPatch(keeper, loser, patch, cols);
  if (measurements) patch.service_area_measurements = measurements;
  if (!Object.keys(patch).length) return;
  const before = {};
  for (const f of Object.keys(patch)) before[f] = keeper[f] ?? null;
  await knex('customer_properties').where({ id: keeperId }).update(patch);
  state.filled.push({ keeper: keeperId, from: loserId, before, wrote: Object.keys(patch) });
}

function pickKeeper(rows) {
  return rows.find((r) => r.is_primary)
    || [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id)))[0];
}

/**
 * A card's proposals after the fold. Returns null when nothing changed.
 * keyFor(id, staged): the new key for a staged key whose address is
 * unchanged since staging, else the staged key itself.
 */
function rewriteProposals(proposals, { keeperOf, rowById }) {
  const keyFor = (id, staged) => {
    const row = rowById.get(id);
    return row && staged && staged === oldKey(row) ? newKey(row) : staged;
  };
  const out = [];
  let changed = false;
  for (const p of proposals || []) {
    const q = { ...p };
    if (q.kind === 'occupancy_change') {
      q.address_key = keyFor(q.property_id, q.address_key);
      q.property_id = keeperOf.get(q.property_id) || q.property_id;
    } else if (q.kind === 'primary_flip') {
      q.new_primary_address_key = keyFor(q.new_primary_property_id, q.new_primary_address_key);
      q.old_primary_address_key = keyFor(q.old_primary_property_id, q.old_primary_address_key);
      q.new_primary_property_id = keeperOf.get(q.new_primary_property_id) || q.new_primary_property_id;
      q.old_primary_property_id = keeperOf.get(q.old_primary_property_id) || q.old_primary_property_id;
      // A flip onto the house that is already primary has nothing to do.
      if (q.new_primary_property_id && q.new_primary_property_id === q.old_primary_property_id) { changed = true; continue; }
    }
    if (JSON.stringify(q) !== JSON.stringify(p)) changed = true;
    out.push(q);
  }
  return changed ? out : null;
}

/**
 * A grouped stop (service_visits) is identified by stop_base_key
 * `${property_id}:${date}` + stop_seq, unique together (visit-groups.js
 * stopBaseKey). Moving its property re-anchors the key on the keeper with
 * the next free stop_seq there, so closeout and joins see one stop. The old
 * key and seq are recorded for the audit trail.
 */
async function moveStops(knex, loserId, keeperId, state) {
  const stops = await knex('service_visits').where({ property_id: loserId }).select('id', 'stop_base_key', 'stop_seq');
  const ids = [];
  for (const stop of stops) {
    const base = String(stop.stop_base_key || '');
    const patch = { property_id: keeperId };
    if (base.startsWith(`${loserId}:`)) {
      const nextBase = `${keeperId}${base.slice(loserId.length)}`;
      const top = await knex('service_visits').where({ stop_base_key: nextBase }).max('stop_seq as m').first();
      patch.stop_base_key = nextBase;
      patch.stop_seq = Number(top?.m ?? -1) + 1;
    }
    await knex('service_visits').where({ id: stop.id, property_id: loserId }).update(patch);
    state.stops[stop.id] = { stop_base_key: stop.stop_base_key, stop_seq: stop.stop_seq };
    ids.push(stop.id);
  }
  return ids;
}

async function moveRows(knex, table, loserId, keeperId) {
  const moved = [];
  const ids = (await knex(table).where({ property_id: loserId }).select('id')).map((x) => x.id);
  for (const id of ids) {
    try {
      // SAVEPOINT: a unique refusal must not poison the transaction.
      await knex.transaction((sp) => sp(table).where({ id, property_id: loserId }).update({ property_id: keeperId }));
      moved.push(id);
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
    }
  }
  return moved;
}

async function moveReferences(knex, tables, loserId, keeperId, state) {
  const moved = {};
  for (const table of tables) {
    if (table === 'service_visits') {
      moved.service_visits = await moveStops(knex, loserId, keeperId, state);
      continue;
    }
    const ids = await moveRows(knex, table, loserId, keeperId);
    if (ids.length) moved[table] = ids;
  }
  return moved;
}

function groupActiveRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r.active) continue;
    const key = newKey(r);
    if (!key) continue;
    const g = `${r.customer_id}|${key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

async function foldDuplicates(knex, rows, ctx) {
  const { tables, cols, state, keeperOf } = ctx;
  for (const group of groupActiveRows(rows)) {
    const keeper = pickKeeper(group);
    for (const loser of group.filter((r) => r.id !== keeper.id)) {
      const moved = await moveReferences(knex, tables, loser.id, keeper.id, state);
      await fillKeeper(knex, keeper.id, loser.id, cols, state);
      await knex('customer_properties').where({ id: loser.id }).update({ active: false, is_primary: false, updated_at: knex.fn.now() });
      state.merged.push({ loser: loser.id, keeper: keeper.id, wasPrimary: !!loser.is_primary, moved });
      keeperOf.set(loser.id, keeper.id);
    }
  }
}

// Two phases: an old key can equal another row's new key mid-way, so clear
// every changing key before assigning any.
async function rekeyRows(knex, rows, state) {
  const rekey = rows.filter((r) => (newKey(r) || null) !== (r.address_key || null));
  for (const r of rekey) {
    state.keys[r.id] = r.address_key || null;
    await knex('customer_properties').where({ id: r.id }).update({ address_key: null });
  }
  for (const r of rekey) await knex('customer_properties').where({ id: r.id }).update({ address_key: newKey(r) || null });
}

const SAVED_COLS = ['id', 'address_line1', 'address_line2', 'city', 'zip', 'service_area_measurements'];

// Reviewed service-area measurements carry the key they were saved under
// (property-service-areas.js reviewedAreas() drops them on a mismatch): one
// saved under the row's old key follows it to the new one.
async function rekeyMeasurements(knex, state) {
  if (!(await knex.schema.hasColumn('customer_properties', 'service_area_measurements'))) return;
  const saved = await knex('customer_properties').whereNotNull('service_area_measurements').select(SAVED_COLS);
  for (const r of saved) {
    const m = parse(r.service_area_measurements);
    if (!m || typeof m !== 'object' || !m.addressKey || m.addressKey !== oldKey(r) || m.addressKey === newKey(r)) continue;
    await knex('customer_properties').where({ id: r.id })
      .update({ service_area_measurements: JSON.stringify({ ...m, addressKey: newKey(r) }) });
    state.measurements.push(r.id);
  }
}

const RESOLVED_NOTE = 'The proposed primary was the same house as the current primary, spelled two ways (street suffix or direction); the duplicate property was merged into the primary (2026-11-02). Nothing left to apply.';

async function rewriteRoleCards(knex, rows, keeperOf, state) {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const cards = await knex('triage_items').where({ reason_code: ROLE_CARD }).whereIn('status', OPEN_CARD_STATUSES)
    .select('id', 'status', 'payload');
  for (const card of cards) {
    const payload = parse(card.payload) || {};
    const proposals = rewriteProposals(payload.property_role_proposals, { keeperOf, rowById });
    if (!proposals) continue;
    const patch = { payload: JSON.stringify({ ...payload, property_role_proposals: proposals }), updated_at: knex.fn.now() };
    if (!proposals.length) {
      Object.assign(patch, {
        status: 'resolved', resolution_source: 'system', resolution_note: RESOLVED_NOTE, resolved_at: knex.fn.now(),
      });
    }
    await knex('triage_items').where({ id: card.id }).update(patch);
    // What this pass wrote, so down() can tell a card staff touched since.
    const after = await knex('triage_items').where({ id: card.id }).first('status', 'payload');
    state.cards.push({ id: card.id, status: card.status, payload, after: { status: after.status, payload: parse(after.payload) } });
  }
}

/**
 * A stored copy of a key moves only while it still equals the key the OLD
 * code derives from its own row's address, and the update re-checks that, so
 * a row changed meanwhile is left alone. `from` and `to` are the key
 * functions of the direction (up: old to new; down: new to old).
 */
async function moveStoredKeys(knex, { table, column, selectCols, from, to }) {
  if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) return [];
  const rows = await knex(table).whereNotNull(column).select(selectCols);
  const done = [];
  for (const r of rows) {
    const before = from(r);
    const after = to(r);
    if (before === after || r[column] !== before) continue;
    await knex(table).where({ id: r.id, [column]: before }).update({ [column]: after });
    done.push(r.id);
  }
  return done;
}

const HOME_LINE = { table: 'customers', column: 'home_line_address_key', selectCols: ['id', 'address_line1', 'address_line2', 'city', 'zip', 'home_line_address_key'] };
const PERMIT_KEY = { table: 'pool_permit_records', column: 'address_key', selectCols: ['id', 'address_line1', 'city', 'zip', 'address_key'] };

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  const hasSettings = await knex.schema.hasTable('system_settings');
  // A re-run must not overwrite the state down() needs.
  if (hasSettings && (await knex('system_settings').where({ key: STATE_KEY }).first())) return;

  const tables = await referenceTables(knex);
  const hasTriage = await knex.schema.hasTable('triage_items');
  await lockTables(knex, tables, hasTriage);

  const rows = await knex('customer_properties').select(...ADDRESS_COLS);
  const state = { keys: {}, merged: [], cards: [], stops: {}, measurements: [], filled: [], homeLines: [], permits: 0 };
  const cols = new Set();
  for (const c of [...FILL_FIELDS, 'occupancy_type', 'latitude', 'longitude', 'service_area_measurements']) {
    if (await knex.schema.hasColumn('customer_properties', c)) cols.add(c);
  }
  const keeperOf = new Map();

  await foldDuplicates(knex, rows, { tables, cols, state, keeperOf });
  await rekeyRows(knex, rows, state);
  await rekeyMeasurements(knex, state);
  if (hasTriage) await rewriteRoleCards(knex, rows, keeperOf, state);
  state.homeLines = await moveStoredKeys(knex, { ...HOME_LINE, from: oldKey, to: newKey });
  state.permits = (await moveStoredKeys(knex, { ...PERMIT_KEY, from: oldKey, to: newKey })).length;

  if (hasSettings) await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
};

async function restoreCards(knex, state) {
  for (const c of state.cards || []) {
    // Only a card still exactly as this pass left it: a staff decision or
    // edit made since stands.
    const now = await knex('triage_items').where({ id: c.id }).first('status', 'payload');
    if (!now || !c.after || now.status !== c.after.status
      || JSON.stringify(parse(now.payload)) !== JSON.stringify(c.after.payload)) continue;
    await knex('triage_items').where({ id: c.id }).update({
      status: c.status, payload: JSON.stringify(c.payload), resolution_source: null, resolution_note: null, resolved_at: null, updated_at: knex.fn.now(),
    });
  }
}

// Old-format keys rebuilt from each row's CURRENT address (an address edited,
// or a row added, since up() keys as the old code would), in two phases so no
// single write can meet the unique index mid-way. The old format keeps apart
// houses the new one merges ("Ave E" / "Avenue East"), so rows added since up()
// can share an old key with an active row: active rows of one customer that
// would share an old key keep their current key, and rollback never fails on
// the unique index.
async function restoreKeys(knex) {
  const rows = await knex('customer_properties')
    .select('id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip', 'address_key', 'active');
  const oldCount = new Map();
  for (const r of rows) {
    if (!r.active) continue;
    const k = `${r.customer_id}|${oldKey(r)}`;
    oldCount.set(k, (oldCount.get(k) || 0) + 1);
  }
  const changed = rows.filter((r) => (oldKey(r) || null) !== (r.address_key || null)
    && !(r.active && oldCount.get(`${r.customer_id}|${oldKey(r)}`) > 1));
  for (const r of changed) await knex('customer_properties').where({ id: r.id }).update({ address_key: null });
  for (const r of changed) await knex('customer_properties').where({ id: r.id }).update({ address_key: oldKey(r) || null });
}

// Reactivate the copies (one whose old key now matches another active row
// stays retired; the index would refuse it). References are NOT moved back,
// and facts copied onto the keeper stay: the copy was the same house, so
// everything the keeper gained (visits, estimates, grouped stops, lawn
// history, sizes, measurements) stays together there.
async function reactivateCopies(knex, state) {
  for (const m of state.merged || []) {
    try {
      await knex.transaction((sp) => sp('customer_properties').where({ id: m.loser, active: false })
        .update({ active: true, is_primary: !!m.wasPrimary, updated_at: knex.fn.now() }));
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
    }
  }
}

// Every reviewed measurement saved under its row's new key goes to the row's
// old key, which is what the rolled-back code compares it with.
async function restoreMeasurements(knex) {
  if (!(await knex.schema.hasColumn('customer_properties', 'service_area_measurements'))) return;
  const saved = await knex('customer_properties').whereNotNull('service_area_measurements').select(SAVED_COLS);
  for (const r of saved) {
    const m = parse(r.service_area_measurements);
    if (!m || typeof m !== 'object' || !m.addressKey || m.addressKey !== newKey(r) || m.addressKey === oldKey(r)) continue;
    await knex('customer_properties').where({ id: r.id })
      .update({ service_area_measurements: JSON.stringify({ ...m, addressKey: oldKey(r) }) });
  }
}

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  const state = parse(row.value);
  const tables = await referenceTables(knex);
  const hasTriage = await knex.schema.hasTable('triage_items');
  await lockTables(knex, tables, hasTriage);

  if (hasTriage) await restoreCards(knex, state);
  await restoreKeys(knex);
  await reactivateCopies(knex, state);
  await restoreMeasurements(knex);
  await moveStoredKeys(knex, { ...HOME_LINE, from: newKey, to: oldKey });
  await moveStoredKeys(knex, { ...PERMIT_KEY, from: newKey, to: oldKey });
  await knex('system_settings').where({ key: STATE_KEY }).del();
};

exports.STATE_KEY = STATE_KEY;
exports.REFERENCE_TABLES = REFERENCE_TABLES;
exports.oldKey = oldKey;
exports.newKey = newKey;
