/**
 * One house, one address key (ops review 2026-10-01; owner "fix it properly").
 *
 * addressKey now keys street (suffix-canonical, more USPS forms such as
 * Gln/Glen, Cv/Cove) + unit (both unit sources, never suffix-mapped) + the
 * 5-digit ZIP, or the city only when there is no ZIP. Under the old key
 * (street + unit + city + ZIP, fewer suffixes) the call pipeline minted a
 * second property for the same house: 11 customers in production, each a
 * primary plus a label-less copy created seconds later.
 *
 * In ONE transaction, holding every table it reads or writes:
 *   1. folds, per customer, the active rows that share a new key into one
 *      keeper (the primary, else the oldest row): each property_id
 *      reference moves to the keeper (a reference the keeper already holds
 *      under a unique index stays on the retired copy as history) and the
 *      copy is retired (active = false, is_primary = false);
 *   2. rewrites every stored customer_properties.address_key;
 *   3. rewrites the open property-role cards (triage_items
 *      'property_role_confirm'), whose staged proposals carry address keys
 *      and property ids: a key staged for an address that has not changed
 *      since is re-keyed, a proposal naming a retired copy is re-pointed at
 *      its keeper, a primary flip onto the house that is already primary is
 *      dropped, and a card left with nothing to apply is resolved by the
 *      system with a note. A key that was already stale stays stale (the
 *      card's own fences skip it, as before).
 *
 * The lock (SHARE ROW EXCLUSIVE: reads continue, writes wait) is taken
 * before the first read, so no booking, address edit or primary flip lands
 * between the snapshot and the writes; lock_timeout fails the migration
 * (and the deploy) rather than queueing behind a long transaction.
 *
 * The old and new key functions are FROZEN copies here, so this migration
 * does the same thing whenever it runs. A test pins the new copy to the
 * live addressKey; a later change to addressKey needs its own migration.
 *
 * No customer communication: plain row updates, no application hooks.
 * Saved service-area measurements carry no addressKey in production
 * (checked 2026-10-01). down() reverses exactly what up() did, from its
 * system_settings state row.
 */

const STATE_KEY = 'migration.20261002090000.state';

// ── Frozen key functions ─────────────────────────────────────────────────
const normStreet = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normalizeZip = (z) => (String(z || '').match(/\d{5}/) || [''])[0];
const stripUnitDesignators = (s) => String(s || '')
  .replace(/[.,#]/g, ' ')
  .replace(/\b(?:apt|apartment|unit|ste|suite)\b\.?/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const unitKey = (s) => normStreet(stripUnitDesignators(s));

const LEGACY_SUFFIX = {
  st: 'street', street: 'street', ave: 'avenue', avenue: 'avenue', rd: 'road', road: 'road',
  dr: 'drive', drive: 'drive', ln: 'lane', lane: 'lane', ct: 'court', court: 'court',
  blvd: 'boulevard', boulevard: 'boulevard', cir: 'circle', circle: 'circle',
  pl: 'place', place: 'place', ter: 'terrace', terrace: 'terrace', way: 'way',
  trl: 'trail', trail: 'trail', pkwy: 'parkway', parkway: 'parkway', hwy: 'highway', highway: 'highway',
};
const SUFFIX = {
  ...LEGACY_SUFFIX,
  gln: 'glen', glen: 'glen', cv: 'cove', cove: 'cove', trce: 'trace', trace: 'trace',
  xing: 'crossing', crossing: 'crossing', lndg: 'landing', landing: 'landing',
  rdg: 'ridge', ridge: 'ridge', crk: 'creek', creek: 'creek', holw: 'hollow', hollow: 'hollow',
  sq: 'square', square: 'square', bnd: 'bend', bend: 'bend', aly: 'alley', alley: 'alley',
  vw: 'view', view: 'view', vis: 'vista', vista: 'vista', cswy: 'causeway', causeway: 'causeway',
  plz: 'plaza', plaza: 'plaza', pt: 'point', point: 'point', mdw: 'meadow', meadow: 'meadow',
  mdws: 'meadows', meadows: 'meadows', hts: 'heights', heights: 'heights', psge: 'passage', passage: 'passage',
};
const canonical = (map) => (s) => String(s || '').toLowerCase().replace(/[.,#]/g, ' ')
  .split(/\s+/).map((w) => map[w] || w).join(' ');

/** customer-properties addressKey as it was before 2026-10-02. */
function legacyKey({ address_line1, address_line2, city, zip } = {}) {
  const streetUnit = stripUnitDesignators([address_line1, address_line2].filter(Boolean).join(' '));
  return canonical(LEGACY_SUFFIX)([streetUnit, city, normalizeZip(zip)].filter(Boolean).join(' ')).replace(/[^a-z0-9]/g, '');
}

const stripTrailingUnit = (s) => String(s || '').replace(/\s+(?:apt|apartment|unit|ste|suite|#)\.?\s*[a-z0-9-]+\s*$/i, '').trim();
const streetEmbeddedUnitKey = (s) => {
  const m = String(s || '').match(/(?:\b(?:apt|apartment|unit|ste|suite)|#)\.?\s*([a-z0-9-]+)\s*$/i);
  return m ? normStreet(m[1]) : '';
};
const INLINE_UNIT_TAIL_RE = /\s(?:(?:apt|apartment|unit|ste|suite)\b|#)\s*((?:[a-z]?\d|[a-z]\b).*)$/i;

/** customer-properties addressKey from 2026-10-02 (pinned to the live helper by a test). */
function newKey({ address_line1, address_line2, city, zip } = {}) {
  const line1 = String(address_line1 || '').replace(/[.,]/g, ' ').replace(/#/g, ' #').replace(/\s+/g, ' ').trim();
  const inline = line1.match(INLINE_UNIT_TAIL_RE);
  const street = canonical(SUFFIX)(stripTrailingUnit(inline ? line1.slice(0, inline.index) : line1)).replace(/[^a-z0-9]/g, '');
  const embedded = inline ? unitKey(inline[1]) : streetEmbeddedUnitKey(line1);
  const line2 = unitKey(address_line2);
  const unit = embedded && line2 && embedded !== line2 ? `${embedded}${line2}` : (embedded || line2);
  const locality = normalizeZip(zip) || normStreet(city);
  return `${street}${unit}${locality}`;
}

// ── Tables ──────────────────────────────────────────────────────────────
// Every uuid property reference in production (information_schema,
// 2026-10-01), minus field_credit_allocations: its field_program_immutable
// trigger refuses any UPDATE, so its rows stay on a retired copy as the
// history they are (none belonged to a duplicate on 2026-10-02). The
// scheduled_services triggers fire only on date / window / status, so
// moving property_id sends no reminder. Tables or columns missing in an
// environment are skipped.
const REFERENCE_TABLES = [
  'scheduled_services', 'estimates', 'lawn_assessments', 'lawn_baseline_resets',
  'lawn_protocol_service_completions', 'visual_service_moments', 'lawn_diagnostics',
  'tree_shrub_assessments', 'pest_identifications', 'service_visits',
  'property_notification_prefs', 'property_text_decisions',
  'photo_id_issues', 'visit_prep_submissions',
];
const ROLE_CARD = 'property_role_confirm';
const OPEN_CARD_STATUSES = ['open', 'in_progress', 'snoozed'];

async function referenceTables(knex) {
  const out = [];
  for (const table of REFERENCE_TABLES) {
    if ((await knex.schema.hasTable(table)) && (await knex.schema.hasColumn(table, 'property_id'))) out.push(table);
  }
  return out;
}

function pickKeeper(rows) {
  return rows.find((r) => r.is_primary)
    || [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || String(a.id).localeCompare(String(b.id)))[0];
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/**
 * A card's proposals after the fold. Returns null when nothing changed.
 * keyFor(id, staged): the new key for a staged key whose address is
 * unchanged since staging, else the staged key itself.
 */
function rewriteProposals(proposals, { keeperOf, rowById }) {
  const keyFor = (id, staged) => {
    const row = rowById.get(id);
    return row && staged && staged === legacyKey(row) ? newKey(row) : staged;
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
 * key and seq are recorded; down() leaves stops on the keeper.
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

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  const hasSettings = await knex.schema.hasTable('system_settings');
  // A re-run must not overwrite the state down() needs.
  if (hasSettings && (await knex('system_settings').where({ key: STATE_KEY }).first())) return;

  const tables = await referenceTables(knex);
  const hasTriage = await knex.schema.hasTable('triage_items');
  const locked = ['customer_properties', ...tables, ...(hasTriage ? ['triage_items'] : [])];
  await knex.raw("SET LOCAL lock_timeout = '20s'");
  await knex.raw(`LOCK TABLE ${locked.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);

  const rows = await knex('customer_properties')
    .select('id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip', 'address_key', 'active', 'is_primary', 'created_at');
  const state = { keys: {}, merged: [], cards: [], stops: {} };
  const keeperOf = new Map();

  // 1. Fold same-house active rows.
  const groups = new Map();
  for (const r of rows) {
    if (!r.active) continue;
    const key = newKey(r);
    if (!key) continue;
    const g = `${r.customer_id}|${key}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = pickKeeper(group);
    for (const loser of group.filter((r) => r.id !== keeper.id)) {
      const moved = {};
      for (const table of tables) {
        if (table === 'service_visits') {
          moved.service_visits = await moveStops(knex, loser.id, keeper.id, state);
          continue;
        }
        const ids = (await knex(table).where({ property_id: loser.id }).select('id')).map((x) => x.id);
        for (const id of ids) {
          try {
            // SAVEPOINT: a unique refusal must not poison the transaction.
            await knex.transaction((sp) => sp(table).where({ id, property_id: loser.id }).update({ property_id: keeper.id }));
            (moved[table] = moved[table] || []).push(id);
          } catch (e) {
            if (!(e && e.code === '23505')) throw e;
          }
        }
      }
      await knex('customer_properties').where({ id: loser.id }).update({ active: false, is_primary: false, updated_at: knex.fn.now() });
      state.merged.push({ loser: loser.id, keeper: keeper.id, wasPrimary: !!loser.is_primary, moved });
      keeperOf.set(loser.id, keeper.id);
    }
  }

  // 2. Every stored key (retired rows too).
  // Two phases: an old key can equal another row's new key mid-way (e.g.
  // a unit "ROAD" with a city vs "RD" without one), so clear every changing
  // key before assigning any.
  const rekey = rows.filter((r) => (newKey(r) || null) !== (r.address_key || null));
  for (const r of rekey) {
    state.keys[r.id] = r.address_key || null;
    await knex('customer_properties').where({ id: r.id }).update({ address_key: null });
  }
  for (const r of rekey) await knex('customer_properties').where({ id: r.id }).update({ address_key: newKey(r) || null });

  // 3. Open property-role cards.
  if (hasTriage) {
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
          status: 'resolved',
          resolution_source: 'system',
          resolution_note: 'The proposed primary was the same house as the current primary, entered twice; the duplicate property was merged into the primary (2026-10-02). Nothing left to apply.',
          resolved_at: knex.fn.now(),
        });
      }
      await knex('triage_items').where({ id: card.id }).update(patch);
      // What this pass wrote, so down() can tell a card staff touched since.
      const after = await knex('triage_items').where({ id: card.id }).first('status', 'payload');
      state.cards.push({ id: card.id, status: card.status, payload, after: { status: after.status, payload: parse(after.payload) } });
    }
  }

  if (hasSettings) await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify(state) });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return;
  const state = parse(row.value);
  const tables = await referenceTables(knex);
  const hasTriage = await knex.schema.hasTable('triage_items');
  const locked = ['customer_properties', ...tables, ...(hasTriage ? ['triage_items'] : [])];
  await knex.raw("SET LOCAL lock_timeout = '20s'");
  await knex.raw(`LOCK TABLE ${locked.join(', ')} IN SHARE ROW EXCLUSIVE MODE`);

  if (hasTriage) {
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
  for (const m of state.merged || []) {
    // Grouped stops, and every visit that belongs to a stop, stay on the
    // keeper (the same house): moving a stop back consistently would mean
    // tracking every reschedule and member that joined since, and leaving
    // them is always consistent. Everything else goes back.
    for (const [table, ids] of Object.entries(m.moved || {})) {
      if (!ids.length || !tables.includes(table) || table === 'service_visits') continue;
      let back = ids;
      if (table === 'scheduled_services') {
        const rows = await knex('scheduled_services').whereIn('id', ids).select('id', 'visit_id');
        back = rows.filter((r) => !r.visit_id).map((r) => r.id);
        if (!back.length) continue;
      }
      await knex(table).whereIn('id', back).where({ property_id: m.keeper }).update({ property_id: m.loser });
    }
  }
  // Old-format keys rebuilt from each row's CURRENT address (an address
  // edited, or a row added, since up() keys as the old code would), in two
  // phases so no single write can meet the unique index mid-way.
  const rows = await knex('customer_properties')
    .select('id', 'customer_id', 'address_line1', 'address_line2', 'city', 'zip', 'address_key', 'active');
  // The new format tells apart some units the old one merged ("RD" and
  // "ROAD" both keyed "road"). Active rows of one customer that would share
  // an old key keep their current key, so rollback never fails on the
  // unique index and both stay distinct properties.
  const legacyCount = new Map();
  for (const r of rows) {
    if (!r.active) continue;
    const k = `${r.customer_id}|${legacyKey(r)}`;
    legacyCount.set(k, (legacyCount.get(k) || 0) + 1);
  }
  const changed = rows.filter((r) => (legacyKey(r) || null) !== (r.address_key || null)
    && !(r.active && legacyCount.get(`${r.customer_id}|${legacyKey(r)}`) > 1));
  for (const r of changed) await knex('customer_properties').where({ id: r.id }).update({ address_key: null });
  for (const r of changed) await knex('customer_properties').where({ id: r.id }).update({ address_key: legacyKey(r) || null });
  // Reactivate the copies. One whose old key now matches another active row
  // (re-entered since) stays retired; the index would refuse it.
  for (const m of state.merged || []) {
    try {
      await knex.transaction((sp) => sp('customer_properties').where({ id: m.loser, active: false })
        .update({ active: true, is_primary: !!m.wasPrimary, updated_at: knex.fn.now() }));
    } catch (e) {
      if (!(e && e.code === '23505')) throw e;
    }
  }
  await knex('system_settings').where({ key: STATE_KEY }).del();
};

exports.STATE_KEY = STATE_KEY;
exports.legacyKey = legacyKey;
exports.newKey = newKey;
