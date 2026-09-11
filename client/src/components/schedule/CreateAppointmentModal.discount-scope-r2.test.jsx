/**
 * PR #4405 Codex round 2, the two CreateAppointmentModal P1s — both pure
 * functions so the whole 200-property modal need not be mounted:
 *
 * 1. resolveAppointmentDiscountGroup — which cadence submit group actually
 *    carries an appointment-level discount. It looked only at
 *    service_key_filter (or the operator's "Applies to" scope key) and
 *    otherwise defaulted to the FIRST group, ignoring service_category_filter
 *    entirely. In a split-cadence booking whose first group is pest and
 *    later group is lawn, a lawn-category appointment discount was posted
 *    with the pest appointment, reached no line there, and never appeared
 *    on the lawn appointment where it was eligible.
 *
 * 2. percentExclusionsSaveBlocked / stackingSaveBlocked — a percentage
 *    discount previewed against an unresolved exclusion catalog withheld
 *    every line from the preview while Save stayed enabled, so the server
 *    (which keeps its own exclusion catalog) applied the discount and
 *    persisted a different total than the operator was shown.
 */
import { describe, it, expect } from 'vitest';
import {
  lineMatchesDiscountScope,
  resolveAppointmentDiscountGroup,
  stackingSaveBlocked,
  percentExclusionsSaveBlocked,
} from './CreateAppointmentModal';

const lineServiceKey = (svc) => svc.serviceKey;
const PEST = { serviceKey: 'pest_general_quarterly', category: 'pest_control' };
const LAWN = { serviceKey: 'lawn_fert_monthly', category: 'lawn_care' };
// The booking's cadence groups, in submit order: pest books first.
const GROUPS = [
  { key: 'quarterly', lines: [PEST] },
  { key: 'monthly', lines: [LAWN] },
];

describe('resolveAppointmentDiscountGroup (r2 P1 — category-scoped discounts)', () => {
  it('routes a CATEGORY-scoped lawn discount to the lawn group, not the first group', () => {
    const discount = { service_category_filter: 'lawn_care', service_key_filter: null };
    const group = resolveAppointmentDiscountGroup(GROUPS, discount, '', lineServiceKey);
    expect(group?.key).toBe('monthly');
    // Pre-fix: no service_key_filter and no scopeKey meant `key` was null,
    // so the whole find() was skipped and groups[0] (pest) was chosen —
    // where the discount matches no line and is silently dropped.
    expect(group?.lines).toEqual([LAWN]);
  });

  it('still honors an exact service-key filter', () => {
    const discount = { service_key_filter: 'lawn_fert_monthly' };
    expect(resolveAppointmentDiscountGroup(GROUPS, discount, '', lineServiceKey)?.key).toBe('monthly');
  });

  it('honors the operator "Applies to" scope key over an unfiltered preset', () => {
    const discount = { service_key_filter: null, service_category_filter: null };
    expect(resolveAppointmentDiscountGroup(GROUPS, discount, 'lawn_fert_monthly', lineServiceKey)?.key)
      .toBe('monthly');
  });

  it('key AND category are AND-ed: a mismatched pair matches no group', () => {
    const discount = { service_key_filter: 'pest_general_quarterly', service_category_filter: 'lawn_care' };
    expect(resolveAppointmentDiscountGroup(GROUPS, discount, '', lineServiceKey)).toBeNull();
  });

  it('an unscoped discount is appointment-wide — still the first group', () => {
    const discount = { service_key_filter: null, service_category_filter: null };
    expect(resolveAppointmentDiscountGroup(GROUPS, discount, '', lineServiceKey)?.key).toBe('quarterly');
  });

  it('the group choice and per-line eligibility agree on the same scope test', () => {
    const discount = { service_category_filter: 'lawn_care' };
    const group = resolveAppointmentDiscountGroup(GROUPS, discount, '', lineServiceKey);
    // Every line of the chosen group that the discount reaches must pass
    // the same predicate the modal's appointmentDiscountReaches applies.
    expect(group.lines.some((svc) => lineMatchesDiscountScope(svc, discount, '', lineServiceKey))).toBe(true);
    expect(lineMatchesDiscountScope(PEST, discount, '', lineServiceKey)).toBe(false);
  });
});

describe('percentExclusionsSaveBlocked (r2 P1 — unknown exclusion catalog)', () => {
  it('blocks saving a PERCENTAGE appointment discount while the exclusion list is unresolved', () => {
    expect(percentExclusionsSaveBlocked({
      discount: { discount_type: 'percentage' }, excludedKeys: null,
    })).toBe(true);
    expect(percentExclusionsSaveBlocked({
      discount: { discount_type: 'variable_percentage' }, excludedKeys: null,
    })).toBe(true);
  });

  it('does not block once the catalog loads, even when it is empty', () => {
    expect(percentExclusionsSaveBlocked({
      discount: { discount_type: 'percentage' }, excludedKeys: new Set(),
    })).toBe(false);
  });

  it('never blocks a fixed-dollar discount or no discount at all', () => {
    expect(percentExclusionsSaveBlocked({
      discount: { discount_type: 'fixed_amount' }, excludedKeys: null,
    })).toBe(false);
    expect(percentExclusionsSaveBlocked({ discount: null, excludedKeys: null })).toBe(false);
  });
});

describe('stackingSaveBlocked (r2 P1 — unconfirmed gate)', () => {
  it('blocks only when a second discount is actually in play and the gate is unknown', () => {
    expect(stackingSaveBlocked({ known: false, appointmentDiscountSelected: { id: 'd1' } })).toBe(true);
    expect(stackingSaveBlocked({ known: true, appointmentDiscountSelected: { id: 'd1' } })).toBe(false);
    // A plain single-discount save is untouched — the gate-off path stays
    // byte-identical to main whether or not the probe answered.
    expect(stackingSaveBlocked({ known: false, appointmentDiscountSelected: null })).toBe(false);
  });
});
