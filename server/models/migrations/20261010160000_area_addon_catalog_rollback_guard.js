/**
 * Rollback guard for 20261008200000 (area add-on catalog rows) and 20261008220000 (web sweep closeout).
 *
 * 20261008200000's down() deletes each service it inserted (by recorded id) when nothing references it, and each completion
 * profile and tax row it inserted while the insertion marker is still in the row's notes. It never looks at the other
 * fields, so a row an operator edited in the Service Library (price, name, duration, flags, the license, the tax mark, the
 * closeout rules) or on a profile or tax row was deleted on rollback when no visit used it yet. 20261008220000's down()
 * resets the web sweep's closeout source to inferred while its marker is still there; an operator edit that echoes the
 * marker back (the Service Library form submits every field) keeps the marker, so the reset changed the rules the operator
 * saved. Both files are pushed and frozen, so the guard lives here: a rollback runs THIS down() first (it is the later
 * migration), and for each add-on key it compares every field the migrations wrote on the service row, its profile row and
 * its tax row, with the values the later area add-on migrations set (the license, the tax mark, two catalog notes).
 *
 *  - A key with any edited row is taken out of the older migration's state row (services, profiles and tax rows together),
 *    so the older down() leaves the service, its profile and its tax row as the operator left them.
 *  - A web sweep whose closeout rules were edited while its marker stayed gets the 'manual' source, which is what the
 *    Service Library stamps on an edit and what the web sweep's down() skips. The rules themselves are not touched.
 *
 * up() changes nothing. A key whose rows are all still what the migrations wrote is untouched, so an unedited rollback
 * behaves exactly as before. A service row an operator edited in a column the migrations did not write is detected for the
 * five chemical add-ons by its updated_at (the Service Library stamps it on every save); the web sweep's updated_at is
 * stamped by 20261008220000 itself, so only its written fields and closeout rules are compared.
 */
const catalog = require('./20261008200000_area_addon_catalog_rows');
const license = require('./20261008210000_area_addon_license_category');
const sweep = require('./20261008220000_area_addon_web_sweep_closeout');
const notesFix = require('./20261010130000_area_addon_catalog_notes_fix');

// 20261008200000 does not export these.
const MARKER = '[area_addon_catalog_action=inserted]';
const STATUTE = 'FL §212.05(1)(i)1';
const INFERRED_SOURCES = [null, undefined, '', 'inferred_v1', 'default', 'fallback_inference'];
const TOUCHED_AFTER_MS = 1000;

const isNull = (value) => value === null || value === undefined;
function same(actual, expected) {
  if (isNull(expected)) return isNull(actual);
  if (typeof expected === 'number') return Number(actual) === expected;
  return actual === expected;
}
// Every field must equal what the migrations left there.
const matches = (row, fields) => Object.entries(fields).every(([col, value]) => same(row[col], value));

function serviceFields(raw) {
  const { tax_category: _taxCategory, ...svc } = raw;
  return {
    ...svc,
    billing_type: 'one_time',
    pricing_type: 'variable',
    is_waveguard: false,
    is_taxable: true,
    tax_service_key: svc.category,
    requires_license: false,
    license_category: null,
    min_tech_skill_level: 1,
    customer_visible: true,
    booking_enabled: false,
    is_active: true,
    is_archived: false,
    color: svc.category === 'pest_control' ? '#dc2626' : '#16a34a',
  };
}

// What the later area add-on migrations set on the row, in place of the seed value: the tax mark (20261008240000), the license
// on the chemical rows (20261008210000) and the two corrected notes (20261010130000). Each only changes a row that still held
// the seed value, so a row that reads differently now was edited (a change back to the seed value is an edit too).
function laterServiceValues(raw) {
  const note = notesFix.NOTES.find((n) => n.serviceKey === raw.service_key);
  return {
    is_taxable: false,
    ...(license.CHEMICAL_SERVICE_KEYS.includes(raw.service_key) ? { requires_license: true, license_category: license.LICENSE_CATEGORY } : {}),
    ...(note ? { internal_notes: note.after } : {}),
  };
}

function closeoutEdited(row, key) {
  const source = row.closeout_requirements_source;
  if (INFERRED_SOURCES.includes(source)) return false;
  if (key !== sweep.SERVICE_KEY || source !== sweep.SOURCE_MARKER) return true;
  return !(row.requires_service_report === true && row.requires_application_log === false && Number(row.required_photo_count) === 0
    && row.requires_customer_signature === false && row.requires_customer_notice === false);
}

function touchedAfterSeed(row, key) {
  if (key === sweep.SERVICE_KEY || !row.created_at || !row.updated_at) return false;
  return new Date(row.updated_at).getTime() - new Date(row.created_at).getTime() > TOUCHED_AFTER_MS;
}

const serviceEdited = (row, raw) => !matches(row, { ...serviceFields(raw), ...laterServiceValues(raw) })
  || closeoutEdited(row, raw.service_key) || touchedAfterSeed(row, raw.service_key);

const profileEdited = (row, raw) => !matches(row, {
  service_name_snapshot: raw.name,
  category: raw.category,
  billing_type: 'one_time',
  completion_mode: 'service_report',
  project_type: null,
  delivery_mode: 'auto_send',
  creates_service_record: true,
  portal_visibility: 'token_only',
  portal_attach_policy: 'recurring_customer',
  followup_policy: 'none',
  default_followup_days: null,
  active: true,
  notes: MARKER,
});

const taxabilityEdited = (row, raw) => !matches(row, {
  service_label: raw.name,
  is_taxable: true,
  tax_category: raw.tax_category,
  fl_statute_ref: STATUTE,
  residential_taxable: false,
  notes: `${MARKER} Follows dethatching: residential not taxed, commercial taxed.`,
});

exports.MARKER = MARKER;
exports.serviceEdited = serviceEdited;
exports.profileEdited = profileEdited;
exports.taxabilityEdited = taxabilityEdited;

exports.up = async function up() {};

async function readState(knex) {
  const row = await knex('system_settings').where({ key: catalog.STATE_KEY }).first();
  if (!row) return null;
  try { return { services: [], profiles: [], taxability: [], ...JSON.parse(row.value) }; } catch { return null; }
}

// The keys with an edited service row, profile row or tax row among what the catalog migration recorded.
async function editedKeys(knex, state) {
  const rawOf = (key) => catalog.SERVICES.find((s) => s.service_key === key);
  const edited = new Set();
  for (const entry of state.services) {
    const raw = entry && entry.id ? rawOf(entry.key) : null;
    const row = raw ? await knex('services').where({ id: entry.id }).first() : null;
    if (row && serviceEdited(row, raw)) edited.add(entry.key);
  }
  const checks = [['service_completion_profiles', state.profiles, profileEdited], ['service_taxability', state.taxability, taxabilityEdited]];
  for (const [table, keys, isEdited] of checks) {
    if (!(await knex.schema.hasTable(table))) continue;
    for (const key of keys) {
      const raw = rawOf(key);
      const row = raw ? await knex(table).where({ service_key: key }).first() : null;
      if (row && isEdited(row, raw)) edited.add(key);
    }
  }
  return edited;
}

// The web sweep keeps the closeout source its own down() would reset when the rules still match what that migration wrote; a
// row whose rules an operator changed (and whose form echoed the marker back) is marked 'manual', which that down() skips.
async function keepEditedSweepCloseout(knex) {
  const row = await knex('services').where({ service_key: sweep.SERVICE_KEY }).first();
  if (!row || row.closeout_requirements_source !== sweep.SOURCE_MARKER || !closeoutEdited(row, sweep.SERVICE_KEY)) return;
  await knex('services').where({ service_key: sweep.SERVICE_KEY, closeout_requirements_source: sweep.SOURCE_MARKER }).update({ closeout_requirements_source: 'manual' });
}

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  await keepEditedSweepCloseout(knex);
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const state = await readState(knex);
  if (!state) return;
  const edited = await editedKeys(knex, state);
  if (!edited.size) return;
  await knex('system_settings').where({ key: catalog.STATE_KEY }).update({
    value: JSON.stringify({
      ...state,
      services: state.services.filter((entry) => !(entry && edited.has(entry.key))),
      profiles: state.profiles.filter((key) => !edited.has(key)),
      taxability: state.taxability.filter((key) => !edited.has(key)),
    }),
  });
};
