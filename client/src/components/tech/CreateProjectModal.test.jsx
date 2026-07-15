// @vitest-environment jsdom
/**
 * WDO Complete Service sheet — inspection date + Property & scope prefill.
 *
 * Date: the sheet must show the linked visit's calendar date. Callers have
 * passed both 'YYYY-MM-DD' and full ISO timestamps (a Postgres DATE
 * serialized at UTC midnight); a raw timestamp is invalid for a date input,
 * which silently blanks the field on iOS and saves the raw string.
 *
 * Prefill: structure footprint (customers.property_sqft), the
 * manufactured/mobile construction mapping (customers.property_type), and
 * the inspection fee (the linked visit's quoted price) seed blank fields
 * only — hand-typed values always win.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

vi.mock('./WdoIntelligenceBar', () => ({ default: () => null }));
vi.mock('./DictationButton', () => ({ default: () => null }));
vi.mock('../AddressAutocomplete', () => ({ default: () => null }));

import CreateProjectModal from './CreateProjectModal';
import * as projectTypesModule from '../../../../server/services/project-types.js';

const PROJECT_TYPES = projectTypesModule.PROJECT_TYPES
  || projectTypesModule.default?.PROJECT_TYPES;

const baseCustomer = {
  id: 9,
  first_name: 'Mike',
  last_name: 'Padil',
  phone: '+18138133734',
  address_line1: '15766 High Bell Pl',
  city: 'Bradenton',
  state: 'FL',
  zip: '34212',
  property_type: 'Single Family Residential',
  property_sqft: 2200,
};

let customerPayload;

function jsonResponse(payload) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
}

beforeEach(() => {
  customerPayload = { ...baseCustomer };
  vi.stubGlobal('fetch', vi.fn((url) => {
    const u = String(url);
    if (u.includes('/admin/projects/types')) return jsonResponse({ types: PROJECT_TYPES });
    if (u.includes('/estimates-summary')) return jsonResponse({ customer: customerPayload, estimates: [] });
    return jsonResponse({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// The sheet portals to document.body, so queries go through document, not
// the render container.
function renderWdoSheet(overrides = {}) {
  return render(
    <CreateProjectModal
      theme="light"
      presentation="sheet"
      defaultCustomerId="9"
      defaultCustomerLabel="Mike Padil"
      defaultScheduledServiceId="55"
      defaultProjectDate="2026-07-16"
      defaultInspectionFee={175}
      defaultProjectType="wdo_inspection"
      allowedProjectTypes={['wdo_inspection']}
      onClose={() => {}}
      onCreated={() => {}}
      {...overrides}
    />,
  );
}

const field = (key) => document.querySelector(`#create-project-wdo_inspection-${key}`);
const dateInput = () => document.querySelector('input[type="date"]');

describe('CreateProjectModal WDO inspection date', () => {
  it('shows the visit date passed as YYYY-MM-DD', async () => {
    renderWdoSheet();
    await waitFor(() => expect(dateInput()).toBeTruthy());
    expect(dateInput().value).toBe('2026-07-16');
  });

  it('takes the date part of an ISO-timestamp default instead of blanking the input', async () => {
    renderWdoSheet({ defaultProjectDate: '2026-07-16T00:00:00.000Z' });
    await waitFor(() => expect(dateInput()).toBeTruthy());
    expect(dateInput().value).toBe('2026-07-16');
  });
});

describe('CreateProjectModal WDO Property & scope prefill', () => {
  it('prefills footprint from property_sqft and fee from the visit price', async () => {
    renderWdoSheet();
    await waitFor(() => expect(field('structure_sqft')).toBeTruthy());
    await waitFor(() => expect(field('structure_sqft').value).toBe('2200'));
    expect(field('inspection_fee').value).toBe('175');
    // Construction is not derivable for a single-family home — never guessed.
    expect(field('structure_type').value).toBe('');
  });

  it('maps a manufactured/mobile property_type onto the construction select', async () => {
    customerPayload.property_type = 'Manufactured Home';
    renderWdoSheet();
    await waitFor(() => expect(field('structure_type')).toBeTruthy());
    await waitFor(() => expect(field('structure_type').value).toBe('Manufactured / Mobile Home'));
  });

  it('leaves the fee blank when the visit carries no price', async () => {
    renderWdoSheet({ defaultInspectionFee: '' });
    await waitFor(() => expect(field('inspection_fee')).toBeTruthy());
    await waitFor(() => expect(field('structure_sqft').value).toBe('2200'));
    expect(field('inspection_fee').value).toBe('');
  });
});
