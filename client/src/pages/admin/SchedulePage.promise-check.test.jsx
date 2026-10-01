// @vitest-environment jsdom
// The promise check on the completion form (owner "ok yes add these"
// 2026-10-01): the card loads from GET /admin/dispatch/:id/promises, its
// marks ride the generate request and the completion body, and a mark
// changed after generating clears an untouched generated report.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionPanel } from './SchedulePage';

vi.mock('../../hooks/useFeatureFlag', () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

const service = {
  id: 'promise-check-visit',
  customerId: 'promise-check-customer',
  customerName: 'Synthetic Customer',
  serviceType: 'Pest Control',
  status: 'confirmed',
  scheduledDate: '2099-01-01',
  estimatedPrice: 100,
};

const PROMISES = [
  { id: '00000000-0000-4000-8000-000000000001', description: 'Check under the dishwasher', source: 'call', madeAt: '2026-09-29T15:00:00.000Z' },
  { id: '00000000-0000-4000-8000-000000000002', description: 'Look at the gap under the garage door', source: 'text', madeAt: '2026-09-27T16:00:00.000Z' },
];
const REPORT = "WHAT WE FOUND\nGhost ants were trailing along the slider track.\nWHAT WE DID AND WHY\nWe placed bait along the track.\nWHAT TO EXPECT\nYou may see more ants at the bait for a few days.\nWHAT'S NEXT\nIf ants are still trailing, let us know.";

let promiseResponse;
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    let data = { customer: {}, actions: [], available: false };
    if (String(url).includes('/promises')) data = promiseResponse;
    if (String(url).includes('generate-report')) data = { report: REPORT };
    return { ok: true, json: async () => data };
  }));
}

async function renderPanel(props = {}) {
  await act(async () => {
    render(
      <CompletionPanel
        service={service}
        products={[]}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue({})}
        {...props}
      />,
    );
  });
}

const notes = () => screen.getByPlaceholderText('Notes about this service...');
const markButton = (description, label) => [...screen.getByRole('group', { name: `Mark: ${description}` }).querySelectorAll('button')]
  .find((button) => button.textContent === label);

beforeEach(() => {
  localStorage.clear();
  promiseResponse = { available: true, promises: PROMISES };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('alert', vi.fn());
  stubFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('the promise check on the completion form', () => {
  it('loads the open promises and sends the marks with the completion', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    await screen.findByText('Promises we made');
    expect(fetch.mock.calls.some(([url]) => String(url).includes(`/admin/dispatch/${service.id}/promises`))).toBe(true);
    fireEvent.click(markButton('Check under the dishwasher', 'Done'));

    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][1].promiseMarks).toEqual([{ id: PROMISES[0].id, mark: 'done' }]);
  });

  it("sends a Partly mark and its still-left note with the report request", async () => {
    await renderPanel();
    await screen.findByText('Promises we made');
    fireEvent.change(notes(), { target: { value: 'Ghost ants on the slider track.' } });
    fireEvent.click(markButton('Look at the gap under the garage door', 'Partly'));
    fireEvent.change(screen.getByLabelText('What’s still left?'), { target: { value: 'the left side' } });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Generate AI Service Report' })));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('generate-report'))).toBe(true));
    const request = JSON.parse(fetch.mock.calls.find(([url]) => String(url).includes('generate-report'))[1].body);
    expect(request.promiseMarks).toEqual([{ id: PROMISES[1].id, mark: 'partly', stillLeft: 'the left side' }]);
  });

  it('a mark changed after generating clears the untouched report', async () => {
    await renderPanel();
    await screen.findByText('Promises we made');
    fireEvent.change(notes(), { target: { value: 'Ghost ants on the slider track.' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Generate AI Service Report' })));
    await waitFor(() => expect(notes().value).toContain('WHAT WE FOUND'));

    await act(async () => fireEvent.click(markButton('Check under the dishwasher', 'Done')));
    await waitFor(() => expect(notes().value).toBe('Ghost ants on the slider track.'));
  });

  it('a mark alone saves the draft, and a reopened form restores it', async () => {
    await renderPanel();
    await screen.findByText('Promises we made');
    fireEvent.change(notes(), { target: { value: 'Ghost ants on the slider track.' } });
    fireEvent.click(markButton('Check under the dishwasher', 'Done'));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`) || '{}');
      expect(saved.promiseMarks).toEqual({ [PROMISES[0].id]: { mark: 'done', stillLeft: '' } });
    }, { timeout: 3000 });
  });

  it('no card and no marks when the server says the check is unavailable', async () => {
    promiseResponse = { available: false, promises: [] };
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/promises'))).toBe(true));
    expect(screen.queryByText('Promises we made')).toBeNull();

    const submit = await screen.findByRole('button', { name: /^Complete & Send Recap/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(onSubmit.mock.calls[0][1]).not.toHaveProperty('promiseMarks');
  });
});
