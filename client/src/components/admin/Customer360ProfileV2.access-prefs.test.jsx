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
    let prefsOverride = {};
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        expect(options?.method).toBe('PUT');
        prefsOverride = { access_notes: 'kept this one' };
        return response({
          success: true,
          saved: true,
          preferences: { ...BASE_PREFS, ...prefsOverride },
          rejected: [{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }],
        });
      }
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail(prefsOverride));
      }
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const accessNotesLabel = await screen.findByText('Access Notes');
    fireEvent.change(accessNotesLabel.closest('label').querySelector('textarea'), {
      target: { value: 'kept this one' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    // Stays in edit mode so staff can fix the flagged field.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('shows structured pets in the portal shape (type / indoor / temperament)', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({
          pets_structured: [{ name: 'Rex', type: 'Dog', breed: 'Boxer', indoor: 'Outdoor', temperament: 'Aggressive' }],
        }));
      }
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    expect(await screen.findByText('Rex — Dog — Boxer · Outdoor, Aggressive')).toBeInTheDocument();
  });

  it('locks pet count and details while a structured pet list exists', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({ pets_structured: [{ name: 'Rex', type: 'Dog' }] }));
      }
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    expect((await screen.findByText('Pet Count')).closest('label').querySelector('input')).toBeDisabled();
    expect(screen.getByText('Pet Details').closest('label').querySelector('textarea')).toBeDisabled();
  });

  it('keeps the editor open with an error when the save lands but the profile reload fails', async () => {
    let profileLoads = 0;
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        return response({ success: true, saved: true, preferences: BASE_PREFS });
      }
      if (path.endsWith('/admin/customers/customer-a')) {
        profileLoads += 1;
        return profileLoads === 1 ? response(customerDetail()) : response({ error: 'boom' }, 500);
      }
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const notes = (await screen.findByText('Access Notes')).closest('label').querySelector('textarea');
    fireEvent.change(notes, { target: { value: 'Ring twice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved, but the profile couldn't refresh/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('shows a saved pet count of zero as 0, not Not set', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail({ pet_count: 0 }));
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    const row = (await screen.findByText('Pet Count')).parentElement;
    expect(row).toHaveTextContent('0');
    expect(row).not.toHaveTextContent('Not set');
  });

  it('masks access codes and access notes for a technician', async () => {
    localStorage.setItem('waves_admin_user', JSON.stringify({ role: 'technician' }));
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
    await screen.findByText('Access & Preferences');
    expect(screen.queryByText('4477')).not.toBeInTheDocument();
    expect(screen.queryByText('2299')).not.toBeInTheDocument();
    expect(screen.queryByText('8810')).not.toBeInTheDocument();
    expect(screen.queryByText('Latch is on the left')).not.toBeInTheDocument();
    // Three codes plus the side-gate note; empty parking/access notes stay "Not set".
    expect(screen.getAllByText('Shown in the tech app on service day')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Edit Access & Preferences' })).not.toBeInTheDocument();
  });

  it('clicking the Watering Days title does not toggle a day', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail({ watering_days: [] }));
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const title = await screen.findByText('Watering Days');
    fireEvent.click(title);
    const group = title.closest('fieldset');
    expect(group).not.toBeNull();
    expect(group.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0);
  });

  it('legacy day names and retired head types are restated so a correction saves cleanly', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        bodies.push(JSON.parse(options.body));
        return response({ success: true, saved: true, preferences: BASE_PREFS });
      }
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({ watering_days: ['Monday', 'wed'], irrigation_system_type: ['bubbler', 'Spray'] }));
      }
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const days = (await screen.findByText('Watering Days')).closest('fieldset');
    fireEvent.click(Array.from(days.querySelectorAll('button')).find((b) => b.textContent === 'Fri'));
    const types = screen.getByText('Irrigation System Type').closest('fieldset');
    fireEvent.click(Array.from(types.querySelectorAll('button')).find((b) => b.textContent === 'Drip'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].wateringDays).toEqual(['Mon', 'Wed', 'Fri']);
    expect(bodies[0].irrigationSystemType).toEqual(['spray', 'drip']);
  });

  it('locks the form while a save is in flight', async () => {
    let releaseSave;
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        return new Promise((resolve) => {
          releaseSave = () => resolve(new Response(JSON.stringify({ success: true, saved: true, preferences: BASE_PREFS }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        });
      }
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    }));
    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const notes = (await screen.findByText('Access Notes')).closest('label').querySelector('textarea');
    fireEvent.change(notes, { target: { value: 'Ring twice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(notes).toBeDisabled());
    releaseSave();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
  });

  it('an unset contact preference shows Not set, and choosing Text actually saves it', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        bodies.push(JSON.parse(options.body));
        return response({ success: true, saved: true, preferences: BASE_PREFS });
      }
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail({ contact_preference: null }));
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const select = (await screen.findByText('Contact Preference')).closest('label').querySelector('select');
    expect(select.value).toBe('');
    fireEvent.change(select, { target: { value: 'text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({ contactPreference: 'text' });
  });

  it('typing sensitivity details turns the flag on, and both switches are named', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        bodies.push(JSON.parse(options.body));
        return response({ success: true, saved: true, preferences: BASE_PREFS });
      }
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    expect(await screen.findByRole('switch', { name: 'Rain Sensor' })).toBeInTheDocument();
    const flag = screen.getByRole('switch', { name: 'Chemical Sensitivities' });
    expect(flag).toHaveAttribute('aria-checked', 'false');
    const details = screen.getByText('Sensitivity Details').closest('label').querySelector('textarea');
    fireEvent.change(details, { target: { value: 'Asthma in the household' } });
    expect(flag).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ chemicalSensitivities: true, chemicalSensitivityDetails: 'Asthma in the household' });
  });

  it('details typed then the switch turned back off saves the flag OFF', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        bodies.push(JSON.parse(options.body));
        return response({ success: true, saved: true, preferences: BASE_PREFS });
      }
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const flag = await screen.findByRole('switch', { name: 'Chemical Sensitivities' });
    const details = screen.getByText('Sensitivity Details').closest('label').querySelector('textarea');
    fireEvent.change(details, { target: { value: 'Old note, no longer applies' } });
    fireEvent.click(flag);
    expect(flag).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ chemicalSensitivities: false, chemicalSensitivityDetails: 'Old note, no longer applies' });
  });

  it('after a partial save, reverting a SAVED field still sends it on retry', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        const body = JSON.parse(options.body);
        bodies.push(body);
        if (bodies.length === 1) {
          return response({
            success: true,
            saved: true,
            preferences: { ...BASE_PREFS, access_notes: 'B' },
            rejected: [{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }],
          });
        }
        return response({ success: true, saved: true, preferences: BASE_PREFS });
      }
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const notes = (await screen.findByText('Access Notes')).closest('label').querySelector('textarea');
    const hoaEmail = screen.getByText('HOA Email').closest('label').querySelector('input');
    fireEvent.change(notes, { target: { value: 'B' } });
    fireEvent.change(hoaEmail, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    expect(bodies[0]).toMatchObject({ accessNotes: 'B', hoaEmail: 'not-an-email' });

    // Revert the note to its original (empty) value and fix the email.
    fireEvent.change(notes, { target: { value: '' } });
    fireEvent.change(hoaEmail, { target: { value: 'board@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toHaveProperty('accessNotes', '');
    expect(bodies[1]).toHaveProperty('hoaEmail', 'board@example.com');
  });

  it('sends ONLY the field actually changed — not a full-snapshot resubmit that could clobber a newer portal autosave', async () => {
    const fetchMock = vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        const body = JSON.parse(options.body);
        // Only the one touched field rides the PUT — every other
        // BASE_PREFS-backed value (neighborhoodGateCode, petDetails,
        // preferredDay, wateringDays, …) is absent, not merely unchanged.
        expect(Object.keys(body)).toEqual(['accessNotes']);
        return response({ success: true, saved: true, preferences: { ...BASE_PREFS, access_notes: body.accessNotes } });
      }
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const accessNotesLabel = await screen.findByText('Access Notes');
    fireEvent.change(accessNotesLabel.closest('label').querySelector('textarea'), {
      target: { value: 'Only this changed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([u, o]) => String(u).endsWith('/property-preferences') && o?.method === 'PUT',
      )).toBe(true);
    });
  });

  it('clicking Save with nothing changed closes the form without a network call', async () => {
    const fetchMock = vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    await screen.findByText('Access Notes');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/property-preferences') && o?.method === 'PUT')).toBe(false);
  });

  it('blocks Save and shows an inline error for a lone blackout date (client-side mirror of the server rule)', async () => {
    const fetchMock = vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) return response(customerDetail());
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const startLabel = await screen.findByText('Blackout Start');
    fireEvent.change(startLabel.closest('label').querySelector('input'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findAllByText(/set or cleared together/i)).length).toBeGreaterThan(0);
    // Never reached the network — this is a client-side pre-check.
    expect(fetchMock.mock.calls.some(([u, o]) => String(u).endsWith('/property-preferences') && o?.method === 'PUT')).toBe(false);
    // Stays in edit mode so staff can fix it.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('blocks Save when the blackout end date is before the start date', async () => {
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
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const startLabel = await screen.findByText('Blackout Start');
    const endLabel = await screen.findByText('Blackout End');
    fireEvent.change(startLabel.closest('label').querySelector('input'), { target: { value: '2026-12-25' } });
    fireEvent.change(endLabel.closest('label').querySelector('input'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findAllByText(/on or after the start date/i)).length).toBeGreaterThan(0);
  });

  it('sends null (never an empty string) when clearing both blackout dates together', async () => {
    const fetchMock = vi.fn((url, options) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a/property-preferences')) {
        const body = JSON.parse(options.body);
        expect(body.blackoutStart).toBeNull();
        expect(body.blackoutEnd).toBeNull();
        return response({ success: true, saved: true, preferences: { ...BASE_PREFS, blackout_start: null, blackout_end: null } });
      }
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({ blackout_start: '2026-06-01', blackout_end: '2026-06-10' }));
      }
      return response({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    fireEvent.click(screen.getByRole('button', { name: 'Edit Access & Preferences' }));
    const startLabel = await screen.findByText('Blackout Start');
    const endLabel = await screen.findByText('Blackout End');
    fireEvent.change(startLabel.closest('label').querySelector('input'), { target: { value: '' } });
    fireEvent.change(endLabel.closest('label').querySelector('input'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(
        ([u, o]) => String(u).endsWith('/property-preferences') && o?.method === 'PUT',
      )).toBe(true);
    });
  });

  it('shows every editable HOA field (not just name/company) and irrigation issues, and lists pets_structured read-only', async () => {
    vi.stubGlobal('fetch', vi.fn((url) => {
      const path = String(url);
      if (path.endsWith('/admin/payers')) return response({ payers: [] });
      if (path.split('?')[0].endsWith('/timeline')) return response({ timeline: [] });
      if (path.endsWith('/admin/customers/customer-a')) {
        return response(customerDetail({
          // Only hoa_phone set — the old view required hoa_name OR
          // hoa_company to show the section at all, hiding this entirely.
          hoa_name: null,
          hoa_company: null,
          hoa_phone: '941-555-0100',
          hoa_signage_rules: 'No yard signs',
          hoa_timing_restrictions: 'No service before 8am',
          hoa_inspection_period: 'Spring',
          irrigation_issues: 'Zone 3 head is broken',
          pets_structured: [
            { name: 'Rex', species: 'dog', friendly: true, secured: true, notes: 'Kept in the garage' },
          ],
        }));
      }
      return response({});
    }));

    render(<Customer360ProfileV2 customerId="customer-a" onClose={vi.fn()} />);
    await screen.findAllByText('Avery Customer');
    await openPropertyTab();
    await screen.findByText('Access & Preferences');

    // HOA section shows even with only hoa_phone set.
    expect(await screen.findByText('941-555-0100')).toBeInTheDocument();
    expect(screen.getByText('No yard signs')).toBeInTheDocument();
    expect(screen.getByText('No service before 8am')).toBeInTheDocument();
    expect(screen.getByText('Spring')).toBeInTheDocument();

    expect(screen.getByText('Zone 3 head is broken')).toBeInTheDocument();

    expect(screen.getByText(/Rex/)).toBeInTheDocument();
    expect(screen.getByText(/Kept in the garage/)).toBeInTheDocument();
  });
});
