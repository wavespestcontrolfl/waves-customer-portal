// PARITY CHECK for the pure refactor in #4856 ("Split the visit-edit
// retired-plan gate into pairing and decision helpers"): the pre-refactor
// `retiredGateInputsForVisitEdit` (and its `addonLineRecurrence` helper),
// verbatim from origin/main before that commit, is evaluated in isolation
// via `vm` and diffed against the CURRENT split implementation
// (`pairVisitEditAddonLines` / `retainedPlanLinesForVisitEdit` /
// `repatternedAddonLinesForVisitEdit` / `storedAddonRecurrence`, composed
// back together) over a bounded, deterministic grid of stored/posted add-on
// shapes. No network or git access at test time — the pre-refactor source
// is embedded verbatim below.
//
// This intentionally duplicates coverage that already lives in
// tree-shrub-retired-visit-edit-gate.test.js; its purpose is not to pin new
// behavior but to give the refactor itself a wide differential check.
const vm = require('vm');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return { ...actual, adminAuthenticate: (_req, _res, next) => next() };
});
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit: jest.fn() })) })) }));

const newFn = require('../routes/admin-schedule')._test.retiredGateInputsForVisitEdit;

// Verbatim from origin/main server/routes/admin-schedule.js (pre-#4856),
// `addonLineRecurrence` + `retiredGateInputsForVisitEdit`.
const OLD_SOURCE = `
function addonLineRecurrence(line) {
  const pattern = typeof line?.recurringPattern === 'string' && line.recurringPattern.trim() ? line.recurringPattern.trim() : null;
  const intervalDays = Number.parseInt(line?.recurringIntervalDays, 10);
  return pattern || (Number.isInteger(intervalDays) && intervalDays > 0)
    ? { pattern, intervalDays: Number.isInteger(intervalDays) && intervalDays > 0 ? intervalDays : null }
    : null;
}

function retiredGateInputsForVisitEdit({
  current, currentAddons = [], postedServiceId = null, postedAddons = null, serviceType, plansRetainedLines = false,
}) {
  const addonsReplaced = Array.isArray(postedAddons);
  const norm = (v) => String(v || '').trim().toLowerCase();
  const lines = (postedAddons || []).filter(Boolean);
  const named = (l) => typeof l.serviceName === 'string' && !!l.serviceName.trim();
  const labelOf = (l) => ({ label: l.serviceName.trim(), recurrence: addonLineRecurrence(l) });
  const renamed = typeof serviceType === 'string' && !!serviceType.trim() && norm(serviceType) !== norm(current.service_type);
  const primaryLabel = typeof serviceType === 'string' && serviceType.trim() ? serviceType : (current.service_type || null);
  const pairs = (l, a) => (l.serviceId
    ? String(a?.service_id || '') === String(l.serviceId)
    : (!a?.service_id && norm(a?.service_name) === norm(l.serviceName)));
  const pairedLine = new Map();
  const pairedStored = new Map();
  const pairUp = (l, idx) => { pairedLine.set(idx, l); pairedStored.set(l, currentAddons[idx]); };
  const rowIdOf = (l) => (l.submittedAddonId != null ? l.submittedAddonId : l.id);
  const sameRow = (l, a) => rowIdOf(l) != null && a?.id != null && String(rowIdOf(l)) === String(a.id);
  for (const l of lines) {
    const idx = currentAddons.findIndex((a, i) => !pairedLine.has(i) && sameRow(l, a) && pairs(l, a));
    if (idx >= 0) pairUp(l, idx);
  }
  let primaryIdFree = !!current.service_id;
  const takePrimaryId = (id) => {
    if (!primaryIdFree || !id || String(id) !== String(current.service_id)) return false;
    primaryIdFree = false;
    return true;
  };
  const primaryAddedIds = [];
  if (postedServiceId && !takePrimaryId(postedServiceId)) {
    const idx = currentAddons.findIndex((a, i) => !pairedLine.has(i) && String(a?.service_id || '') === String(postedServiceId));
    if (idx >= 0) {
      pairUp({ serviceId: String(postedServiceId), serviceName: null, recurringPattern: null, recurringIntervalDays: null }, idx);
      const moved = currentAddons[idx];
      if (moved?.recurring_pattern) primaryAddedIds.push(String(postedServiceId));
    } else primaryAddedIds.push(String(postedServiceId));
  }
  for (const l of lines) {
    if (pairedStored.has(l)) continue;
    const idx = currentAddons.findIndex((a, i) => !pairedLine.has(i) && pairs(l, a));
    if (idx >= 0) pairUp(l, idx);
  }
  const storedLine = (l) => pairedStored.get(l) || null;
  const postedFor = (a) => pairedLine.get(currentAddons.indexOf(a)) || null;
  const addedLines = lines.filter((l) => !pairedStored.has(l) && !takePrimaryId(l.serviceId));
  const storedRecurrence = (a) => addonLineRecurrence({ recurringPattern: a?.recurring_pattern, recurringIntervalDays: a?.recurring_interval_days });
  const effectiveRecurrence = (a) => { const posted = postedFor(a); return posted ? addonLineRecurrence(posted) : storedRecurrence(a); };
  const ridesPlan = (a) => (effectiveRecurrence(a)?.pattern || null) !== 'one_time';
  const retainedAddons = currentAddons.filter((a) => ridesPlan(a) && (!addonsReplaced || postedFor(a)));
  const primaryRetained = !postedServiceId || String(postedServiceId) === String(current.service_id || '');
  const retainedIds = plansRetainedLines
    ? [primaryRetained ? current.service_id : null, ...retainedAddons.map((a) => a?.service_id)].filter(Boolean).map(String)
    : [];
  const retainedNames = plansRetainedLines
    ? [
      ...(primaryRetained && !renamed && typeof current.service_type === 'string' && current.service_type.trim() ? [current.service_type] : []),
      ...retainedAddons.filter((a) => typeof a?.service_name === 'string' && a.service_name.trim())
        .map((a) => ({ label: a.service_name, recurrence: effectiveRecurrence(a) })),
    ]
    : [];
  const cadenceKey = (r) => (r ? \`\${r.pattern || ''}|\${r.intervalDays || ''}\` : '');
  const repatterned = current.is_recurring && !plansRetainedLines
    ? lines.filter((l) => {
      const stored = storedLine(l);
      return stored && (l.recurringPattern || null) !== 'one_time' && cadenceKey(storedRecurrence(stored)) !== cadenceKey(addonLineRecurrence(l));
    })
    : [];
  return {
    serviceIds: [...new Set([
      ...primaryAddedIds,
      ...addedLines.filter((l) => l.serviceId).map((l) => String(l.serviceId)),
      ...retainedIds,
      ...repatterned.filter((l) => l.serviceId).map((l) => String(l.serviceId)),
    ])],
    serviceTypes: [
      ...(renamed || primaryAddedIds.length ? [primaryLabel].filter(Boolean) : []),
      ...addedLines.filter(named).map(labelOf),
      ...retainedNames,
      ...repatterned.filter(named).map(labelOf),
    ],
  };
}
this.retiredGateInputsForVisitEdit = retiredGateInputsForVisitEdit;
this.addonLineRecurrence = addonLineRecurrence;
`;

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(OLD_SOURCE, sandbox);
const oldFn = sandbox.retiredGateInputsForVisitEdit;
const oldAddonLineRecurrence = sandbox.addonLineRecurrence;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (typeof a === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i]) && ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const RETIRED_ID = 'retired-1';
const LIVE_ID = 'live-1';
const OTHER_ID = 'other-1';

// Curated (not cartesian) stored-row shapes: with/without a row id, each
// catalog id, id-less-by-name, one_time vs plan-cadence vs interval-cadence,
// and two stored copies of the same service (one one_time, one riding the
// parent) to exercise the pairing helper's per-row cadence resolution.
const r0 = { id: 'row-0', service_id: LIVE_ID, service_name: 'Quarterly T&S', recurring_pattern: null, recurring_interval_days: null };
const r1 = { id: 'row-1', service_id: LIVE_ID, service_name: 'Quarterly T&S', recurring_pattern: 'one_time', recurring_interval_days: null };
const r2 = { service_id: RETIRED_ID, service_name: 'Bi-Monthly Tree & Shrub Care', recurring_pattern: 'custom', recurring_interval_days: 90 };
const r3 = { id: 'row-3', service_id: null, service_name: 'Quarterly T&S', recurring_pattern: null, recurring_interval_days: null };
const r4 = { id: 'row-4', service_id: OTHER_ID, service_name: null, recurring_pattern: 'custom', recurring_interval_days: 60 };
const r5 = { service_id: null, service_name: null, recurring_pattern: null, recurring_interval_days: null };
const r6 = { id: 'row-6', service_id: RETIRED_ID, service_name: 'Quarterly T&S', recurring_pattern: null, recurring_interval_days: null };

const CURRENT_ADDONS_GRID = [
  [], [r0], [r1], [r2], [r3], [r4], [r5], [r6],
  [r0, r1], [r2, r6], [r3, r4, r6], [r0, r2, r5],
];

// Curated posted-line shapes, including submittedAddonId pairing against the
// stored rows above and a duplicated line (second copy = an added line).
const l0 = { serviceId: LIVE_ID, serviceName: 'Quarterly T&S', recurringPattern: null, recurringIntervalDays: null };
const l1 = { serviceId: LIVE_ID, serviceName: 'Quarterly T&S', recurringPattern: 'one_time', recurringIntervalDays: null };
const l2 = { serviceId: RETIRED_ID, serviceName: 'Bi-Monthly Tree & Shrub Care', recurringPattern: 'quarterly', recurringIntervalDays: null };
const l3 = { serviceId: null, serviceName: 'Quarterly T&S', recurringPattern: null, recurringIntervalDays: null };
const l4 = { serviceId: OTHER_ID, serviceName: null, recurringPattern: 'custom', recurringIntervalDays: 90 };
const l5 = { serviceId: RETIRED_ID, serviceName: 'Quarterly T&S', recurringPattern: null, recurringIntervalDays: null, submittedAddonId: 'row-6' };
const l6 = { serviceId: LIVE_ID, serviceName: 'Quarterly T&S', recurringPattern: null, recurringIntervalDays: null, submittedAddonId: 'row-0' };

const POSTED_ADDONS_GRID = [
  null, [], [l0], [l1], [l2], [l3], [l4], [l0, l0], [l0, l1], [l5, l6], [l3, l4, l2],
];

const CURRENT_GRID = [
  { service_id: LIVE_ID, service_type: 'Quarterly Pest Control', is_recurring: false, recurring_pattern: null, recurring_interval_days: null },
  { service_id: LIVE_ID, service_type: 'Quarterly Pest Control', is_recurring: true, recurring_pattern: 'monthly', recurring_interval_days: null },
  { service_id: RETIRED_ID, service_type: 'Tree & Shrub', is_recurring: true, recurring_pattern: 'quarterly', recurring_interval_days: null },
  { service_id: null, service_type: null, is_recurring: false, recurring_pattern: null, recurring_interval_days: null },
  { service_id: OTHER_ID, service_type: 'Lawn Care', is_recurring: true, recurring_pattern: 'custom', recurring_interval_days: 60 },
  { service_id: RETIRED_ID, service_type: '', is_recurring: false, recurring_pattern: null, recurring_interval_days: null },
  { service_id: LIVE_ID, service_type: 'Tree & Shrub', is_recurring: true, recurring_pattern: null, recurring_interval_days: null },
];

const POSTED_SERVICE_IDS = [undefined, null, RETIRED_ID, LIVE_ID, OTHER_ID];
const SERVICE_TYPES = [undefined, null, '', 'Quarterly Pest Control', 'RENAMED Service'];

describe('visit-edit retired-plan gate refactor parity (#4856)', () => {
  test('addonLineRecurrence: old and new agree on every pattern/interval combination', () => {
    for (const recurringPattern of [null, 'one_time', 'quarterly', 'custom', 'weird', '', '   ']) {
      for (const recurringIntervalDays of [null, undefined, 0, -5, 30, '30', 'nope', 90.7]) {
        const line = { recurringPattern, recurringIntervalDays };
        expect(newFn === undefined).toBe(false); // sanity: export resolved
        const oldR = oldAddonLineRecurrence(line);
        const newR = require('../routes/admin-schedule')._test.addonLineRecurrence(line);
        expect(deepEqual(oldR, newR)).toBe(true);
      }
    }
  });

  test('retiredGateInputsForVisitEdit: old and new agree over a bounded grid of current/stored/posted shapes', () => {
    let count = 0;
    const divergences = [];
    // Curated (non-cartesian) shapes at every level keep this in the tens of
    // thousands of cases, running in a couple of seconds.
    for (const current of CURRENT_GRID) {
      for (const currentAddons of CURRENT_ADDONS_GRID) {
        for (const postedServiceId of POSTED_SERVICE_IDS) {
          for (const postedAddons of POSTED_ADDONS_GRID) {
            for (const serviceType of SERVICE_TYPES) {
              for (const plansRetainedLines of [true, false]) {
                const input = { current, currentAddons, postedServiceId, postedAddons, serviceType, plansRetainedLines };
                count += 1;
                let oldResult; let oldErr;
                let newResult; let newErr;
                try { oldResult = oldFn(JSON.parse(JSON.stringify(input))); } catch (e) { oldErr = e; }
                try { newResult = newFn(JSON.parse(JSON.stringify(input))); } catch (e) { newErr = e; }
                if (oldErr && newErr) continue;
                if ((!!oldErr) !== (!!newErr) || !deepEqual(oldResult, newResult)) {
                  divergences.push({
                    input, oldResult, oldErr: oldErr && oldErr.message, newResult, newErr: newErr && newErr.message,
                  });
                }
              }
            }
          }
        }
      }
    }
    if (divergences.length) {
       
      console.log(`Compared ${count} cases. First divergence:`, JSON.stringify(divergences[0], null, 2));
    }
    expect(divergences.slice(0, 3)).toEqual([]);
    expect(count).toBeGreaterThan(20000);
  });
});
