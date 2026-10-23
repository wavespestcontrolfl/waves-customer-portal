import { describe, expect, it } from 'vitest';
import {
  FINAL_EXTERIOR_NOT_DONE,
  pretreatWarrantyValues,
  warrantyContractBasis,
  warrantyEligible,
  warrantyPlanYears,
} from './pretreatWarrantyValues';

const findings = {
  treatment_date: '2026-10-01',
  treatment_method: 'Soil barrier (chemical)',
  treatment_address: '12 Test Lane, Bradenton, FL 34202',
  lot_block: 'Lot 4',
  subdivision: 'Test Grove',
  permit_number: 'BP-0001',
  builder_contractor: 'Example Homes LLC',
  product_name: 'Termidor SC',
  active_ingredient: 'fipronil',
  concentration_pct: '0.06',
  gallons_applied: '180',
  square_footage: '1800',
  applicator_name: 'Sam Tester',
  applicator_fdacs_id: 'JF000000',
  warranty_type: 'Builder 1-year, renewable yearly to year 5',
};

describe('pretreatWarrantyValues', () => {
  it('fills the warranty from the certificate and leaves the office fields empty', () => {
    const v = pretreatWarrantyValues({ project: { id: 'abcd1234-ef56', project_date: '2026-10-01' }, findings, today: '2026-10-23' });
    expect(v.treatment.initial_date).toBe('10/01/2026');
    expect(v.warranty.term_end).toBe('10/01/2027');
    expect(v.warranty.renewal_due).toBe('10/01/2027');
    expect(v.warranty.plan_price).toBe('Included in the treatment price');
    expect(v.warranty.number).toBe('NCW-ABCD1234');
    expect(v.warranty.issue_date).toBe('10/23/2026');
    expect(v.project).toEqual({ builder: 'Example Homes LLC', address: '12 Test Lane, Bradenton, FL 34202', lot: 'Lot 4, Test Grove', permit: 'BP-0001' });
    expect(v.treatment.linear_ft).toBe('N/A');
    expect(v.treatment.final_exterior_line).toBe(FINAL_EXTERIOR_NOT_DONE);
    // The issue route refuses blank merge fields, so these stay for the office.
    expect([v.warranty.treatment_price, v.warranty.renewal_fee, v.warranty.contract_basis, v.warranty.consumer_notice_date, v.issuer.name, v.issuer.title])
      .toEqual(['', '', '', '', '', '']);
  });

  it('prints a recorded final exterior date and runs a prepaid plan to its term', () => {
    const v = pretreatWarrantyValues({ findings: { ...findings, warranty_type: 'Renewable 5-year retreatment bond', final_exterior_date: '2026-12-15' } });
    expect(v.treatment.final_exterior_line).toBe('Final exterior treatment date: 12/15/2026.');
    expect(v.warranty.term_end).toBe('10/01/2031');
    expect(v.warranty.plan_price).toBe('');
  });

  it('falls back to the project date and handles Feb 29', () => {
    const v = pretreatWarrantyValues({ project: { project_date: '2028-02-29' }, findings: { ...findings, treatment_date: '' } });
    expect(v.treatment.initial_date).toBe('02/29/2028');
    expect(v.warranty.term_end).toBe('02/28/2029');
  });

  it('gives no term for an addition or an unknown plan', () => {
    expect(warrantyPlanYears('Addition to an existing building (no warranty required)')).toBeNull();
    expect(pretreatWarrantyValues({ findings: { ...findings, warranty_type: 'No warranty' } }).warranty.term_end).toBe('');
  });

  it('words the two lawful contract bases', () => {
    expect(warrantyContractBasis({ kind: 'master', builder: 'Example Homes LLC', date: '09/01/2026' }))
      .toBe('Issued under the master agreement with Example Homes LLC dated 09/01/2026.');
    expect(warrantyContractBasis({ kind: 'signed', date: '09/30/2026' }))
      .toBe('Signed by the owner or authorized agent before treatment, on 09/30/2026.');
  });

  it('offers the warranty only for one soil-barrier application with a plan', () => {
    expect(warrantyEligible(findings)).toBe(true);
    expect(warrantyEligible({ ...findings, treatment_method: 'Wood treatment (borate)' })).toBe(false);
    expect(warrantyEligible({ ...findings, treatment_method: 'Bait system' })).toBe(false);
    expect(warrantyEligible({ ...findings, additional_applications: [{ treatment_method: 'Wood treatment (borate)', product_name: 'Bora-Care' }] })).toBe(false);
    expect(warrantyEligible({ ...findings, additional_applications: JSON.stringify([{ product_name: '' }]) })).toBe(true);
    expect(warrantyEligible({ ...findings, warranty_type: 'Addition to an existing building (no warranty required)' })).toBe(false);
  });
});
