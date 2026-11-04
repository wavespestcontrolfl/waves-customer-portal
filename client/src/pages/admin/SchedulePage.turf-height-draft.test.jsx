// @vitest-environment jsdom
// The lawn gauge reading (turf-height-capture) is typed input the completion
// sends as manualHeightIn. Every other completion section survives a reload or
// the billing-409 detour through the draft; before this the reading came back
// blank and the completion went out without it.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: (key) => ({ enabled: key === 'turf-height-capture', ready: true }),
}));

// Only the gauge field matters here; the real block fetches and scores photos.
vi.mock('../../components/lawn/LawnAssessmentCompletionBlock', () => ({
  default: ({ showGaugeReading, gaugeHeightIn, onGaugeHeight }) => (showGaugeReading ? (
    <input
      type="number"
      aria-label="Lawn length in inches"
      value={gaugeHeightIn ?? ''}
      onChange={(e) => onGaugeHeight(e.target.value === '' ? null : Number(e.target.value))}
    />
  ) : null),
}));

const service = {
  id: 'turf-height-draft-visit',
  customerId: 'turf-height-draft-customer',
  customerName: 'Synthetic Customer',
  serviceType: 'Every 6 Weeks Lawn Care Service',
  completionProfile: { serviceKey: 'lawn', requiresProducts: true },
  status: 'on_site',
  scheduledDate: '2099-01-01',
  estimatedPrice: 100,
};
const DRAFT_KEY = `waves_completion_draft_${service.id}`;

async function renderPanel() {
  await act(async () => {
    render(
      <CompletionPanel
        service={service}
        products={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue({})}
      />,
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the lawn gauge reading on the completion draft', () => {
  it('a typed reading alone is draft content: it saves with the draft', async () => {
    await renderPanel();
    fireEvent.change(await screen.findByLabelText('Lawn length in inches'), { target: { value: '3.5' } });
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
      expect(saved.turfHeightIn).toBe(3.5);
    }, { timeout: 3000 });
  });

  it('a reopened form restores the reading', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Mowed a little short on the front lawn.',
      turfHeightIn: 3.5,
    }));
    await renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(screen.getByLabelText('Lawn length in inches').value).toBe('3.5'));
  });

  it('a draft saved before the field existed restores an empty reading', async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Older draft.',
    }));
    await renderPanel();
    fireEvent.change(await screen.findByLabelText('Lawn length in inches'), { target: { value: '4' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await waitFor(() => expect(screen.getByLabelText('Lawn length in inches').value).toBe(''));
  });
});
