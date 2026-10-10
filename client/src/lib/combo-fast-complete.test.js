import { describe, expect, it } from 'vitest';
import { comboMembersFor, COMBO_ASSESSMENT_KEYS, COMBO_LANE_KEYS } from './combo-fast-complete';
import { isReserviceVisit } from './pest-fast-complete';
import { createRequire } from 'node:module';

// The server's own descriptions, to run the same fixtures through both (CommonJS, loaded from the client suite).
const nodeRequire = createRequire(import.meta.url);
const serverCombo = nodeRequire('../../../server/services/combo-fast-complete.js');
const { TERMINAL_ROW_STATUSES } = nodeRequire('../../../server/services/visit-context/statuses.js');
const { ASSESSMENT_EXPERIENCE_KEYS } = nodeRequire('../../../server/config/completion-lane-registry.js');

// Synthetic rows: one grouped stop of a pest visit and a lawn visit.
const pest = (overrides = {}) => ({
  id: 'svc-pest', visitId: 'visit-1', status: 'confirmed',
  comboFastCompleteEnabled: true, fastCompleteReportEnabled: true,
  completionProfile: { category: 'pest_control', serviceKey: 'pest_general_quarterly', findingsType: null, companions: [] },
  ...overrides,
});
const lawn = (overrides = {}) => ({
  id: 'svc-lawn', visitId: 'visit-1', status: 'confirmed',
  comboFastCompleteEnabled: true, lawnFastCompleteEnabled: true,
  completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null, companions: [] },
  ...overrides,
});

describe('comboMembersFor', () => {
  it('returns the pest and the lawn member of an exactly-two stop, from either row', () => {
    const rows = [pest(), lawn(), { id: 'other', visitId: 'visit-2' }];
    expect(comboMembersFor(rows[0], rows)).toEqual({ pest: rows[0], lawn: rows[1] });
    expect(comboMembersFor(rows[1], rows)).toEqual({ pest: rows[0], lawn: rows[1] });
  });

  it('is null without the gate flag on a member, a visit id, or the day list', () => {
    expect(comboMembersFor(pest({ comboFastCompleteEnabled: false }), [pest({ comboFastCompleteEnabled: false }), lawn()])).toBeNull();
    expect(comboMembersFor(pest(), [pest(), lawn({ comboFastCompleteEnabled: undefined })])).toBeNull();
    expect(comboMembersFor(pest({ visitId: null }), [pest({ visitId: null }), lawn()])).toBeNull();
    expect(comboMembersFor(pest(), null)).toBeNull();
    expect(comboMembersFor(null, [pest(), lawn()])).toBeNull();
  });

  it('is null for one member, three members, or a row that is not in the list', () => {
    expect(comboMembersFor(pest(), [pest()])).toBeNull();
    const third = pest({ id: 'svc-third' });
    expect(comboMembersFor(pest(), [pest(), lawn(), third])).toBeNull();
    expect(comboMembersFor(pest({ id: 'svc-x' }), [pest(), lawn()])).toBeNull();
  });

  it('is null for two pest or two lawn members', () => {
    expect(comboMembersFor(pest(), [pest(), pest({ id: 'svc-pest-2' })])).toBeNull();
    expect(comboMembersFor(lawn(), [lawn(), lawn({ id: 'svc-lawn-2' })])).toBeNull();
  });

  it.each(['completed', 'cancelled', 'skipped', 'no_show'])('is null when a member is already %s', (status) => {
    expect(comboMembersFor(pest(), [pest(), lawn({ status })])).toBeNull();
    expect(comboMembersFor(pest(), [pest({ status }), lawn()])).toBeNull();
  });

  it('is null when the pest or lawn rule says no (its own flag off, or another lane)', () => {
    expect(comboMembersFor(pest(), [pest({ fastCompleteReportEnabled: false }), lawn()])).toBeNull();
    expect(comboMembersFor(pest(), [pest(), lawn({ lawnFastCompleteEnabled: false })])).toBeNull();
    expect(comboMembersFor(pest(), [pest(), lawn({ completionProfile: { category: 'lawn_care', serviceKey: 'lawn_re_service' } })])).toBeNull();
    expect(comboMembersFor(pest(), [pest({ traceVariant: 'outline' }), lawn()])).toBeNull();
  });

  it.each([
    ['typed findings', { completionProfile: { category: 'pest_control', findingsType: 'cockroach' } }],
    ['a companion form', { completionProfile: { category: 'pest_control', findingsType: null, companions: [{ type: 'rodent_bait' }] } }],
    ['a project-backed profile', { completionProfile: { category: 'pest_control', findingsType: null, projectBacked: true } }],
    ['a required project', { completionProfile: { category: 'pest_control', findingsType: null, requiresProject: true } }],
    ['a linked project', { linkedProject: { id: 'proj-1' } }],
    ['a failed project lookup', { linkedProjectLookupFailed: true }],
    ['a failed profile lookup', { completionProfileLookupFailed: true }],
    ['a lane visit', { laneVoiceFillEnabled: true }],
    ['a typed report flow', { typedReportFlowEnabled: true }],
    ['a station visit', { stationFastCompleteEnabled: true }],
    ['an invoice already sent', { completionInvoiceAlreadySent: true }],
    ['a checkout invoice (returning from payment)', { checkoutInvoiceId: 'inv-1' }],
    ['a checkout invoice token', { checkoutInvoiceToken: 'tok-1' }],
  ])('is null for a pest member with %s', (_label, overrides) => {
    expect(comboMembersFor(pest(), [pest(overrides), lawn()])).toBeNull();
  });

  it.each([
    ['typed lawn findings', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_one_time', findingsType: 'one_time_lawn_treatment' } }],
    ['a companion form', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', findingsType: null, companions: [{ type: 'x' }] } }],
    ['a project-backed profile', { completionProfile: { category: 'lawn_care', serviceKey: 'lawn_care_recurring', projectBacked: true } }],
    ['a linked project', { linkedProject: { id: 'proj-1' } }],
    ['an invoice already sent', { completionInvoiceAlreadySent: true }],
    ['a checkout invoice', { checkoutInvoiceId: 'inv-1' }],
    ['no completion profile', { completionProfile: null }],
  ])('is null for a lawn member with %s', (_label, overrides) => {
    expect(comboMembersFor(pest(), [pest(), lawn(overrides)])).toBeNull();
  });

  it('reads the snake_case visit id too', () => {
    const rows = [pest({ visitId: undefined, visit_id: 'v-9' }), lawn({ visitId: undefined, visit_id: 'v-9' })];
    expect(comboMembersFor(rows[0], rows)).toEqual({ pest: rows[0], lawn: rows[1] });
  });

  it('ignores terminal history beside the two open members, as the server counts open members', () => {
    const rows = [pest(), lawn(), { ...pest({ id: 'svc-done' }), status: 'completed' }, { ...pest({ id: 'svc-skip' }), status: 'skipped' }, { ...lawn({ id: 'svc-ns' }), status: 'no_show' }, { ...lawn({ id: 'svc-x' }), status: 'cancelled' }];
    expect(comboMembersFor(rows[0], rows)).toEqual({ pest: rows[0], lawn: rows[1] });
    // 'rescheduled' is open on both sides.
    expect(comboMembersFor(pest(), [pest(), lawn(), { ...lawn({ id: 'svc-r' }), status: 'rescheduled' }])).toBeNull();
  });

  it('never makes a pest re-service or callback the pest part; a lawn callback is a lawn visit', () => {
    const rs = { completionProfile: { category: 'pest_control', serviceKey: 'pest_re_service', findingsType: null, companions: [] } };
    expect(comboMembersFor(pest(), [pest(rs), lawn()])).toBeNull();
    expect(comboMembersFor(pest(), [pest({ isCallback: true }), lawn()])).toBeNull();
    expect(comboMembersFor(pest(), [pest({ is_callback: true }), lawn()])).toBeNull();
    const rows = [pest(), lawn({ isCallback: true })];
    expect(comboMembersFor(rows[0], rows)).toEqual({ pest: rows[0], lawn: rows[1] });
  });

  it('refuses a lane visit even while the lane voice fill gate (and so its row flag) is off', () => {
    for (const serviceKey of COMBO_LANE_KEYS) {
      expect(comboMembersFor(pest(), [pest({ laneVoiceFillEnabled: false, completionProfile: { category: 'pest_control', serviceKey, findingsType: null, companions: [] } }), lawn()])).toBeNull();
    }
  });
});

// Drift: the lists and rules the client copies from the server.
describe('client and server descriptions agree', () => {
  it('the lane keys, the terminal statuses and the re-service rule are the server\'s', () => {
    const { VOICE_LANES_KEYS } = { VOICE_LANES_KEYS: Object.keys(nodeRequire('../../../server/services/visit-lane-facts.js').VOICE_LANES || {}) };
    expect([...COMBO_ASSESSMENT_KEYS].sort()).toEqual([...ASSESSMENT_EXPERIENCE_KEYS].sort());
    expect([...COMBO_LANE_KEYS].sort()).toEqual(VOICE_LANES_KEYS.sort());
    expect(TERMINAL_ROW_STATUSES.slice().sort()).toEqual(['cancelled', 'completed', 'no_show', 'skipped']);
    for (const [serviceKey, isCallback] of [['pest_re_service', false], ['pest_general_quarterly', true], ['pest_general_quarterly', false], ['pest_re_service', true]]) {
      expect(isReserviceVisit({ serviceKey, isCallback })).toBe(serverCombo.isPestReservice({ serviceKey }, isCallback));
    }
  });

  // The same pest fixtures through the client (a pair with a plain lawn) and the server's pest rule.
  const PROFILE = { category: 'pest_control', serviceKey: 'pest_general_quarterly', findingsType: null, companions: [] };
  const pestFixtures = [
    ['plain', PROFILE, 'Quarterly Pest Control', false],
    ['re-service key', { ...PROFILE, serviceKey: 'pest_re_service' }, 'Pest Control Re-Service', false],
    ['callback', PROFILE, 'Quarterly Pest Control', true],
    ['typed findings', { ...PROFILE, findingsType: 'cockroach' }, 'Cockroach Control', false],
    ['companions', { ...PROFILE, companions: [{ type: 'rodent_bait_station' }] }, 'Pest Control', false],
    ['project-backed', { ...PROFILE, projectBacked: true }, 'Pest Control', false],
    ['requires a project', { ...PROFILE, requiresProject: true }, 'Pest Control', false],
    ['bed bug lane', { ...PROFILE, serviceKey: 'bed_bug_treatment' }, 'Bed Bug Treatment', false],
    ['fire ant lane', { ...PROFILE, serviceKey: 'fire_ant' }, 'Fire Ant Treatment', false],
    ['lawn category', { ...PROFILE, category: 'lawn_care' }, 'Lawn Care', false],
  ];
  it.each(pestFixtures)('pest member, %s: client and server agree', (_label, profile, serviceType, isCallback) => {
    const row = pest({ serviceType, isCallback, completionProfile: profile });
    const client = comboMembersFor(row, [row, lawn()]) != null;
    expect(serverCombo.pestReportFlowAdmits(profile, serviceType, isCallback)).toBe(client);
  });

  // The same lawn fixtures through the client and the server's lawnFastIneligibleReason (grouped aside).
  const LAWN = { category: 'lawn_care', serviceKey: 'lawn_care_monthly', findingsType: null, companions: [] };
  const lawnFixtures = [
    ['plain', LAWN],
    ['lawn re-service', { ...LAWN, serviceKey: 'lawn_re_service' }],
    ['companions', { ...LAWN, companions: ['tree_shrub'] }],
    ['project-backed', { ...LAWN, projectBacked: true }],
    ['tree & shrub', { ...LAWN, findingsType: 'tree_shrub', serviceKey: 'lawn_tree_shrub_combo' }],
    ['pest category', { ...LAWN, category: 'pest_control' }],
    ...ASSESSMENT_EXPERIENCE_KEYS.map((key) => [`assessment key ${key}`, { ...LAWN, serviceKey: key }]),
  ];
  it.each(lawnFixtures)('lawn member, %s: client and server agree', (_label, profile) => {
    const row = lawn({ completionProfile: profile });
    const client = comboMembersFor(pest(), [pest(), row]) != null;
    const server = nodeRequire('../../../server/services/lawn-fast-complete.js').lawnFastIneligibleReason({ svc: { status: 'confirmed' }, profile }) === null;
    expect(server).toBe(client);
  });
});
