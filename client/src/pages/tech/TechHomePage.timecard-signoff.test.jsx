// @vitest-environment jsdom
// Weekly sign-off card: what the tech attests is what payroll pays. With an
// unpaid lunch on the week the card shows paid hours (regular + overtime) and
// the lunch taken off; with none it is exactly the shift-hours card.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', () => ({ io: () => ({ on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }) }));
vi.mock('../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false, useFeatureFlagReady: () => ({ enabled: false, ready: true }) }));
vi.mock('../../components/tech/TechIntelligenceBar', () => ({ default: () => null }));
vi.mock('../../components/tech/TechNoticeFeed', () => ({ default: () => null }));
vi.mock('../../components/tech/CreateProjectModal', () => ({ default: () => null, wdoFeeSeedFromVisit: () => null }));
vi.mock('../../components/tech/TechTimeTrackingCard', () => ({ default: () => null }));
vi.mock('../../components/tech/TechServicePhotosModal', () => ({ default: () => null }));
vi.mock('../../components/tech/TechTreatmentZoneModal', () => ({ default: () => null }));
vi.mock('../../components/tech/FieldLeadModal', () => ({ default: () => null }));
vi.mock('../../components/ServiceRecapModal', () => ({ default: () => null }));
vi.mock('./VisitBriefPanel', () => ({ default: () => null }));
vi.mock('../../components/tech/useTruckKit', () => ({ default: () => ({ loading: false, data: null, error: '', reload: () => {} }), lastCheckedLabel: () => '' }));
import { TimecardSignoffCard } from './TechHomePage';

const week = (extra) => ({
  weekly: {
    week_start: '2026-10-19',
    status: 'pending',
    tech_signed_at: null,
    job_count: 12,
    total_shift_minutes: '2520.00',
    regular_minutes: '2400.00',
    overtime_minutes: '0.00',
    ...extra,
  },
  weekStart: '2026-10-19',
  pending: true,
  reviewToken: 'token-1',
});

function mountWith(body) {
  localStorage.setItem('waves_admin_token', 'fixture-only');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })));
  return render(<TimecardSignoffCard techName="Fixture Technician" />);
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe('weekly timecard sign-off card', () => {
  it('shows paid hours and the unpaid lunch for a week with lunches taken off', async () => {
    mountWith(week({ unpaid_meal_minutes: '120.00' }));
    expect(await screen.findByText('Sign Last Week\'s Timecard')).toBeInTheDocument();
    expect(screen.getByText('40.0h')).toBeInTheDocument();
    expect(screen.getByText('paid')).toBeInTheDocument();
    expect(screen.getByText('Unpaid lunch')).toBeInTheDocument();
    expect(screen.getByText('2.0h')).toBeInTheDocument();
    expect(screen.queryByText('42.0h')).not.toBeInTheDocument();
  });

  it('is exactly the shift-hours card when the week has no unpaid lunch', async () => {
    mountWith(week({ unpaid_meal_minutes: '0.00', regular_minutes: '2400.00', overtime_minutes: '120.00' }));
    expect(await screen.findByText('42.0h')).toBeInTheDocument();
    expect(screen.getByText('total')).toBeInTheDocument();
    expect(screen.queryByText('Unpaid lunch')).not.toBeInTheDocument();
    expect(screen.queryByText('paid')).not.toBeInTheDocument();
  });

  it('treats a week row from before the column existed as no unpaid lunch', async () => {
    mountWith(week({}));
    expect(await screen.findByText('42.0h')).toBeInTheDocument();
    expect(screen.queryByText('Unpaid lunch')).not.toBeInTheDocument();
  });
});
