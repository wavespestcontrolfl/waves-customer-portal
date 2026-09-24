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

async function mount(onSubmit = vi.fn().mockResolvedValue({})) {
  await act(async () => {
    render(<StrictMode><CompletionPanel service={service} products={[]}
      onClose={vi.fn()} onSubmit={onSubmit} /></StrictMode>);
  });
  return onSubmit;
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
    localStorage.setItem(key, JSON.stringify({ serviceId: service.id, notes: 'Cleared the rating', clientPestRating: null, clientPestRatingTouched: true }));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    // Let an autosave replace the draft snapshot before the gate answers.
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
    await answer({ allowed: true, firstVisit: true });
    expect(pressed()).toEqual([]);
  });

  it('keeps the first-visit 5 when restoring a legacy draft that never touched the picker', async () => {
    localStorage.setItem(key, JSON.stringify({ serviceId: service.id, notes: 'Older draft', clientPestRating: null }));
    await mount();
    await answer({ allowed: true, firstVisit: true });
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(new Set(pressed())).toEqual(new Set(['Rate pest activity 5 out of 5']));
  });

  it('applies the first-visit 5 after restoring a legacy untouched draft first', async () => {
    localStorage.setItem(key, JSON.stringify({ serviceId: service.id, notes: 'Older draft', clientPestRating: null }));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    await act(async () => { await new Promise((r) => setTimeout(r, 900)); });
    await answer({ allowed: true, firstVisit: true });
    expect(new Set(pressed())).toEqual(new Set(['Rate pest activity 5 out of 5']));
  });

  it('restores a draft rating the tech picked', async () => {
    localStorage.setItem(key, JSON.stringify({ serviceId: service.id, notes: 'Picked 2', clientPestRating: 2 }));
    await mount();
    await answer({ allowed: true, firstVisit: true });
    fireEvent.click(screen.getByRole('button', { name: 'Restore', exact: true }));
    expect(new Set(pressed())).toEqual(new Set(['Rate pest activity 2 out of 5']));
  });

  it('never overwrites a tap made before the gate answers', async () => {
    await mount();
    await answer({ allowed: true, firstVisit: false });
    fireEvent.click(screen.getAllByRole('button', { name: 'Rate pest activity 2 out of 5' })[0]);
    expect(new Set(pressed())).toEqual(new Set(['Rate pest activity 2 out of 5']));
  });

  it('sends an explicit clear so the server does not apply the first-visit 5', async () => {
    const onSubmit = await mount();
    await answer({ allowed: true, firstVisit: true });
    fireEvent.click(screen.getAllByRole('button', { name: 'Rate pest activity 5 out of 5' })[0]);
    expect(pressed()).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Complete & Send Recap/i }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const body = onSubmit.mock.calls[0][1];
    expect(body.clientPestRatingCleared).toBe(true);
    expect(body).not.toHaveProperty('clientPestRating');
  });

  it('sends the prefilled 5 with no clear flag', async () => {
    const onSubmit = await mount();
    await answer({ allowed: true, firstVisit: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Complete & Send Recap/i }));
    });
    const body = onSubmit.mock.calls[0][1];
    expect(body.clientPestRating).toBe(5);
    expect(body.clientPestRatingPrefilled).toBe(true);
    expect(body).not.toHaveProperty('clientPestRatingCleared');
  });

  it('a 5 the tech chose is not marked as a prefill', async () => {
    const onSubmit = await mount();
    await answer({ allowed: true, firstVisit: true });
    fireEvent.click(screen.getAllByRole('button', { name: 'Rate pest activity 5 out of 5' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Rate pest activity 5 out of 5' })[0]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Complete & Send Recap/i }));
    });
    const body = onSubmit.mock.calls[0][1];
    expect(body.clientPestRating).toBe(5);
    expect(body).not.toHaveProperty('clientPestRatingPrefilled');
  });

  it('captions the scale with the active labels from the gate', async () => {
    await mount();
    await answer({ allowed: true, firstVisit: false, scaleLabels: ['Very Low', 'Very Low', 'Low', 'Moderate', 'Elevated', 'Severe'] });
    expect(screen.getAllByText(/0 = very low · 1 = very low · 2 = low · 3 = moderate · 4 = elevated · 5 = severe\./).length).toBeGreaterThan(0);
  });
});
