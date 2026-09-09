// @vitest-environment jsdom
// ServiceTracker under the saved-property scope: the arrival checklist's
// gate-code / pet-plan rows come from /property/preferences (keyed by the
// CUSTOMER = the profile's primary address) and are withheld — and not
// fetched — under a NON-primary selection (uncapped codex r1s P1).
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TRACKER = {
  currentStep: 2,
  state: 'scheduled',
  steps: [{ completedAt: '2026-09-14T12:00:00Z' }, { completedAt: null }, { completedAt: null }, { completedAt: null }, { completedAt: null }, { completedAt: null }, { completedAt: null }],
  customerLocation: null, trackUrl: null, office: null, rainChance: null, stopsAhead: null, routeProgress: null, techApprox: null, etaSource: null,
  technician: { name: 'Sam Rivera', initials: 'SR' },
  service: { type: 'Quarterly Pest Control', date: '2026-09-14', windowStart: '09:00:00', windowEnd: '11:00:00' },
  etaMinutes: null, liveNotes: [], serviceSummary: null, techPosition: null,
};
vi.mock('../utils/api', () => ({
  default: {
    getTodayTracker: vi.fn(async () => ({ tracker: TRACKER, propertyScope: undefined })),
    getActiveTracker: vi.fn(async () => ({ tracker: TRACKER, propertyScope: undefined })),
    getPropertyPreferences: vi.fn(async () => ({ preferences: { neighborhoodGateCode: '1234', petCount: 2, petsSecuredPlan: 'Dogs in the garage' } })),
    getWeather: vi.fn(async () => null),
    request: vi.fn(async () => ({})),
  },
}));

let ServiceTracker; let api;
beforeEach(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ({ ServiceTracker } = await import('./PortalPage'));
  ({ default: api } = await import('../utils/api'));
  api.getPropertyPreferences.mockClear();
});
afterEach(() => cleanup());

const primary = { id: 'c1:pa', key: 'c1:pa', customerId: 'c1', propertyId: 'pa', isPrimaryProperty: true };
const secondary = { id: 'c1:pb', key: 'c1:pb', customerId: 'c1', propertyId: 'pb', isPrimaryProperty: false };

describe('ServiceTracker arrival checklist under the saved-property scope', () => {
  it('shows the profile facts (gate code, pet plan) on the PRIMARY house', async () => {
    render(<ServiceTracker currentEntry={primary} savedScope />);
    expect(await screen.findByText('Gate code on file')).toBeInTheDocument();
    expect(screen.getByText(/Pet plan: Dogs in the garage/)).toBeInTheDocument();
    expect(api.getPropertyPreferences).toHaveBeenCalledTimes(1);
  });
  it('withholds them — and never fetches them — on a SECONDARY house; the generic prep reminders stay', async () => {
    render(<ServiceTracker currentEntry={secondary} savedScope />);
    expect(await screen.findByText('Before your tech arrives')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Secure pets before tech arrives')).toBeInTheDocument());
    expect(screen.queryByText('Gate code on file')).not.toBeInTheDocument();
    expect(screen.queryByText('No gate code on file')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pet plan:/)).not.toBeInTheDocument();
    expect(api.getPropertyPreferences).not.toHaveBeenCalled();
  });
  // Another tab switched to a newly added house and the property-list reload
  // failed: the old saved list is retained while the new selection is
  // adopted, so the selection has NO listed entry. The primary's gate code
  // and pet plan must not render on that house (uncapped codex r1z P1).
  it('withholds them when the selection has NO listed entry under a saved list', async () => {
    render(<ServiceTracker currentEntry={null} savedScope selectedProperty={{ customerId: 'c1', propertyId: 'pc' }} />);
    expect(await screen.findByText('Before your tech arrives')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Secure pets before tech arrives')).toBeInTheDocument());
    expect(screen.queryByText('Gate code on file')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pet plan:/)).not.toBeInTheDocument();
    expect(api.getPropertyPreferences).not.toHaveBeenCalled();
  });
  it('withholds them when a house is selected but the retained list is still profile-shaped', async () => {
    render(<ServiceTracker currentEntry={null} savedScope={false} selectedProperty={{ customerId: 'c1', propertyId: 'pc' }} />);
    expect(await screen.findByText('Before your tech arrives')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Secure pets before tech arrives')).toBeInTheDocument());
    expect(screen.queryByText('Gate code on file')).not.toBeInTheDocument();
    expect(api.getPropertyPreferences).not.toHaveBeenCalled();
  });
  it('profile mode (no selection, no saved entries) still shows them', async () => {
    render(<ServiceTracker currentEntry={null} savedScope={false} selectedProperty={null} />);
    expect(await screen.findByText('Gate code on file')).toBeInTheDocument();
    expect(api.getPropertyPreferences).toHaveBeenCalledTimes(1);
  });
});
