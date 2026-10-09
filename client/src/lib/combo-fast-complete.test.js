import { describe, expect, it } from 'vitest';
import { comboMembersFor } from './combo-fast-complete';

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
});
