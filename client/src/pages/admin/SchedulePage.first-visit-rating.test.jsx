// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

// Owner ruling 2026-09-24: on a customer's first visit the pest activity
// picker starts at 5; the tech can change or clear it, and neither a tap
// nor a restored draft is ever overwritten by the late prefill.
const service = {
  id: 'first-visit-rating-visit', customerId: 'first-visit-customer',
  customerName: 'Synthetic Customer', serviceType: 'Quarterly Pest Control Service',
  status: 'confirmed', scheduledDate: '2099-01-01', estimatedPrice: 100,
};
const key = `waves_completion_draft_${service.id}`;

let resolveRating;
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((url) => {
    if (String(url).includes('/tech-rating-allowed')) {
      return new Promise((resolve) => {
        resolveRating = (body) => resolve({ ok: true, json: async () => body });
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ customer: {}, actions: [], available: false }) });
  }));
}

async function mount() {
  await act(async () => {
    render(<StrictMode><CompletionPanel service={service} products={[]}
      onClose={vi.fn()} onSubmit={vi.fn().mockResolvedValue({})} /></StrictMode>);
  });
}

async function answer(body) {
  await act(async () => { resolveRating(body); });
}

const pressed = () => screen.queryAllByRole('button', { pressed: true })
  .map((b) => b.getAttribute('aria-label'))
  .filter((label) => /^Rate pest activity/.test(label || ''));

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  localStorage.clear();
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('first-visit pest activity rating', () => {
  it('starts at 5 on a first visit', async () => {
    await mount();
    await answer({ allowed: true, firstVisit: true });
    const labels = pressed();
    expect(labels.length).toBeGreaterThan(0);
    expect(new Set(labels)).toEqual(new Set(['Rate pest activity 5 out of 5']));
    expect(screen.getAllByText(/First visit — starts at 5/).length).toBeGreaterThan(0);
  });

  it('leaves the picker empty when it is not a first visit', async () => {
    await mount();
    await answer({ allowed: true, firstVisit: false });
    expect(screen.getAllByRole('button', { name: 'Rate pest activity 3 out of 5' }).length).toBeGreaterThan(0);
    expect(pressed()).toEqual([]);
    expect(screen.queryByText(/First visit — starts at 5/)).toBeNull();
  });

  it('never overwrites a restored draft where the tech cleared the rating', async () => {
    localStorage.setItem(key, JSON.stringify({ serviceId: service.id, notes: 'Cleared the rating', clientPestRating: null }));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    // Let an autosave replace the draft snapshot before the gate answers.
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
    await answer({ allowed: true, firstVisit: true });
    expect(pressed()).toEqual([]);
  });

  it('never overwrites a tap made before the gate answers', async () => {
    await mount();
    await answer({ allowed: true, firstVisit: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'Rate pest activity 2 out of 5' })[0]);
    expect(new Set(pressed())).toEqual(new Set(['Rate pest activity 2 out of 5']));
  });
});
