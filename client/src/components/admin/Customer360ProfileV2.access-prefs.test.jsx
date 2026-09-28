// @vitest-environment jsdom
/**
 * Customer 360 → Property → Access & Preferences.
 *
 * Before this, the block silently hid any empty row, never showed
 * garage/lockbox/side-gate codes, watering/mowing days, or preferred
 * day/time, and read four columns (parking_instructions,
 * interior_access_instructions, preferred_service_time,
 * preferred_technician) that don't exist on property_preferences. This
 * pins that staff can now SEE those previously-missing fields (as "Not
 * set" when empty, never silently hidden) and EDIT them through the new
 * PUT /api/admin/customers/:id/property-preferences endpoint.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Customer360ProfileV2 from './Customer360ProfileV2';

vi.mock('./StickyActionBar', () => ({ CustomerActionBar: () => null }));
vi.mock('./AuthenticatedCallAudio', () => ({ default: () => null }));
vi.mock('./CustomerRequestsPanel', () => ({ default: () => null }));
vi.mock('./CallBridgeLink', () => ({
  default: ({ children }) => <span>{children}</span>,
  callViaBridge: vi.fn(),
}));
vi.mock('../../pages/admin/SchedulePage', () => ({
  ZoneMarkingStep: () => null,
  StationMarkingStep: () => null,
}));
vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

const BASE_PREFS = {
  id: 'pref-1',
  customer_id: 'customer-a',
  // Present, non-empty fields the OLD block already rendered — still shown.
  neighborhood_gate_code: '4477',
  pet_details: 'Two friendly labs',
  special_instructions: 'Leave receipts on the porch',
  // Fields the OLD block never rendered at all (a straight hide, not a
  // "Not set") — this is the coverage gap under test.
  property_gate_code: null,
  garage_code: '2299',
  lockbox_code: '8810',
  side_gate_access: 'Latch is on the left',
  parking_notes: null,
  access_notes: null,
  preferred_day: 'monday',
  preferred_time: 'morning',
  contact_preference: 'text',
  irrigation_controller_location: 'Garage wall',
  irrigation_run_minutes: 20,
  watering_days: ['Mon', 'Wed', 'Fri'],
  mowing_days: ['Tue'],
  mowing_time_of_day: 'morning',
  irrigation_system_type: ['spray', 'rotor'],
  chemical_sensitivities: false,
  chemical_sensitivity_details: null,
};

function customerDetail(prefsOverride = {}) {
  return {
    customer: {
      id: 'customer-a',
      firstName: 'Avery',
      lastName: 'Customer',
      address: { line1: '1 Main St', city: 'Bradenton', state: 'FL', zip: '34205' },
      active: true,
    },
    notificationPrefs: {},
    preferences: { ...BASE_PREFS, ...prefsOverride },
    healthScore: {},
    invoices: [], cards: [], paymentMethodConsents: [], contracts: [], photos: [],
    customerDiscounts: [], complianceRecords: [], nutrientLedger: {}, services: [],
    payments: [], scheduled: [], upcomingScheduled: [], accountProperties: [],
    annualPrepayTerms: [],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
  localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'admin' }));
});

async function openPropertyTab() {
  fireEvent.click(await screen.findByRole('button', { name: 'Property' }));
}

describe('Customer 360 → Property → Access & Preferences', () => {
  it('shows garage/lockbox/side-gate codes, watering/mowing days, and preferred day/time — not hidden, not the old dead labels', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();

    expect(await screen.findByText('Access & Preferences')).toBeInTheDocument();

    // Previously-missing fields now render.
    expect(screen.getByText('2299')).toBeInTheDocument(); // garage code
    expect(screen.getByText('8810')).toBeInTheDocument(); // lockbox code
    expect(screen.getByText('Latch is on the left')).toBeInTheDocument(); // side gate
    expect(screen.getByText('Mon, Wed, Fri')).toBeInTheDocument(); // watering days
    expect(screen.getByText('Tue')).toBeInTheDocument(); // mowing days
    expect(screen.getByText('Monday')).toBeInTheDocument(); // preferred day, mapped from enum
    expect(screen.getByText('20')).toBeInTheDocument(); // irrigation run minutes

    // Important-but-empty fields read "Not set" rather than disappear.
    expect(screen.getByText('Property/Yard Gate')).toBeInTheDocument();
    expect(screen.getByText('Parking Notes')).toBeInTheDocument();
    expect(screen.getAllByText('Not set').length).toBeGreaterThan(0);

    // The four dead labels that read nonexistent columns are gone.
    expect(screen.queryByText('Parking Instructions')).not.toBeInTheDocument();
    expect(screen.queryByText('Interior Access')).not.toBeInTheDocument();
    expect(screen.queryByText('Preferred Tech')).not.toBeInTheDocument();
  });

  it('Edit → change Access Notes → Save calls the new admin endpoint and reloads with the saved value', async () => {
    let prefsOverride = {};
    const fetchMock = vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        expect(options?.method).toBe('PUT');
        const body = JSON.parse(options.body);
        expect(body.accessNotes).toBe('Use the side gate as backup');
        prefsOverride = { access_notes: body.accessNotes };
        return response({
          success: true,
          saved: true,
          preferences: { ...BASE_PREFS, ...prefsOverride },
        });
      }
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail(prefsOverride));
      }
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));

    const accessNotesLabel = await screen.findByText('Access Notes');
    const textarea = accessNotesLabel.closest('label').querySelector('textarea');
    fireEvent.change(textarea, { target: { value: 'Use the side gate as backup' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([u, o]) => String(u).endsWith('/admin/customers/customer-a/property-preferences') && o?.method === 'PUT',
      )).toBe(true);
    });

    // Edit form closes and the saved value now shows in the display view.
    await waitFor(() => {
      expect(screen.getByText('Use the side gate as backup')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    // No customer-facing notification is ever sent from this admin path.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('account-updated'))).toBe(false);
  });

  it('shows server-reported rejected fields without discarding the rest of the edit', async () => {
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        expect(options?.method).toBe('PUT');
        return response({
          success: true,
          saved: true,
          preferences: { ...BASE_PREFS, access_notes: 'kept this one' },
          rejected: [{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }],
        });
      }
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({ access_notes: 'kept this one' }));
      }
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    // Stays in edit mode so staff can fix the flagged field.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });
});
