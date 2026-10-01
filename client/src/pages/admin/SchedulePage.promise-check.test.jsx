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
  { id: '00000000-0000-4000-8000-000000000001', description: 'Check under the dishwasher', source: 'call', madeAt: '2026-09-29T15:00:00.000Z', version: '1111111111111111' },
  { id: '00000000-0000-4000-8000-000000000002', description: 'Look at the gap under the garage door', source: 'text', madeAt: '2026-09-27T16:00:00.000Z', version: '2222222222222222' },
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
    expect(onSubmit.mock.calls[0][1].promiseMarks).toEqual([{ id: PROMISES[0].id, mark: 'done', version: PROMISES[0].version }]);
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
    expect(request.promiseMarks).toEqual([{ id: PROMISES[1].id, mark: 'partly', version: PROMISES[1].version, stillLeft: 'the left side' }]);
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
      expect(saved.promiseMarks).toEqual({ [PROMISES[0].id]: { mark: 'done', version: PROMISES[0].version, stillLeft: '' } });
    }, { timeout: 3000 });
  });

  it('a mark is draft content on its own: with nothing else entered, it still saves', async () => {
    await renderPanel();
    await screen.findByText('Promises we made');
    fireEvent.click(markButton('Look at the gap under the garage door', 'Not yet'));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(`waves_completion_draft_${service.id}`) || '{}');
      expect(saved.promiseMarks).toEqual({ [PROMISES[1].id]: { mark: 'not_yet', version: PROMISES[1].version, stillLeft: '' } });
    }, { timeout: 3000 });
  });

  it('a declined visit hides the card and sends no marks', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    await screen.findByText('Promises we made');
    fireEvent.click(markButton('Check under the dishwasher', 'Done'));
    fireEvent.change(screen.getByDisplayValue('Completed'), { target: { value: 'customer_declined' } });
    await waitFor(() => expect(screen.queryByText('Promises we made')).toBeNull());

    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1]).not.toHaveProperty('promiseMarks');
  });

  it('marks a declined visit will not send never hold Complete, even while the list is slow', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/promises')) return new Promise(() => {});
      return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
    }));
    localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Customer declined at the door.',
      promiseMarks: { [PROMISES[0].id]: { mark: 'done', version: PROMISES[0].version, stillLeft: '' } },
    }));
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    fireEvent.change(screen.getByDisplayValue('Completed'), { target: { value: 'customer_declined' } });
    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(alert).not.toHaveBeenCalledWith('Still loading the promises you marked. Try again in a moment.');
    expect(onSubmit.mock.calls[0][1]).not.toHaveProperty('promiseMarks');
  });

  it('a marked promise alone is enough to write the report', async () => {
    await renderPanel();
    await screen.findByText('Promises we made');
    fireEvent.click(markButton('Check under the dishwasher', 'Done'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Generate AI Service Report' })));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('generate-report'))).toBe(true));
    expect(alert).not.toHaveBeenCalled();
  });

  it('a mark changed after the report was edited asks before sending', async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderPanel({ onSubmit });
    await screen.findByText('Promises we made');
    fireEvent.change(notes(), { target: { value: 'Ghost ants on the slider track.' } });
    fireEvent.click(markButton('Check under the dishwasher', 'Done'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Generate AI Service Report' })));
    await waitFor(() => expect(notes().value).toContain('WHAT WE FOUND'));
    // The tech edits the report, then changes the mark.
    fireEvent.change(notes(), { target: { value: `${notes().value} Edited.` } });
    await act(async () => fireEvent.click(markButton('Check under the dishwasher', 'Not yet')));

    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('You changed a promise mark after the report was written'));
    expect(onSubmit).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][1].promiseMarks).toEqual([{ id: PROMISES[0].id, mark: 'not_yet', version: PROMISES[0].version }]);
  });

  it('a restored report whose promise was reworded since clears itself once the list loads', async () => {
    const stale = { [PROMISES[0].id]: { mark: 'done', version: '0000000000000000', stillLeft: '' } };
    localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: REPORT,
      generatedReportText: REPORT,
      installedReportDraft: REPORT,
      preGenerationNotes: 'Ghost ants on the slider track.',
      aiReportUsed: true,
      promiseMarks: stale,
      generationPromiseSignature: JSON.stringify([[PROMISES[0].id, 'done', '0000000000000000', '']]),
    }));
    await renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await screen.findByText('Promises we made');
    await waitFor(() => expect(notes().value).toBe('Ghost ants on the slider track.'));
  });

  it('the marks cannot change while the completion is sending', async () => {
    let finish;
    const onSubmit = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    await renderPanel({ onSubmit });
    await screen.findByText('Promises we made');
    fireEvent.click(markButton('Check under the dishwasher', 'Done'));
    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => { fireEvent.click(submit); });
    await waitFor(() => expect(markButton('Check under the dishwasher', 'Not yet').disabled).toBe(true));
    await act(async () => { finish({}); });
  });

  it('Generate waits while restored marks are still loading, so the report never leaves them out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/promises')) return new Promise(() => {});
      return { ok: true, json: async () => ({ customer: {}, actions: [], available: false, report: REPORT }) };
    }));
    localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Ghost ants on the slider track.',
      promiseMarks: { [PROMISES[0].id]: { mark: 'done', version: PROMISES[0].version, stillLeft: '' } },
    }));
    await renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: /Generate AI Service Report/i })));
    expect(alert).toHaveBeenCalledWith('Still loading the promises you marked. Try again in a moment.');
    expect(fetch.mock.calls.some(([url]) => String(url).includes('generate-report'))).toBe(false);
  });

  it('a restored mark on a promise beyond the newest ten is asked for by id, shown, and sent', async () => {
    const OLDER = { id: '00000000-0000-4000-8000-000000000099', description: 'Recheck the attic vent', source: 'call', madeAt: '2026-08-01T15:00:00.000Z', version: '9999999999999999' };
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      let data = { customer: {}, actions: [], available: false };
      const href = decodeURIComponent(String(url));
      if (href.includes('/promises')) {
        data = { available: true, promises: href.includes(`include=${OLDER.id}`) ? [...PROMISES, OLDER] : PROMISES, total: 12 };
      }
      if (href.includes('generate-report')) data = { report: REPORT };
      return { ok: true, json: async () => data };
    }));
    localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Ghost ants on the slider track.',
      promiseMarks: { [OLDER.id]: { mark: 'done', version: OLDER.version, stillLeft: '' } },
    }));
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    await screen.findByText('Recheck the attic vent');
    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(onSubmit.mock.calls[0][1].promiseMarks).toEqual([{ id: OLDER.id, mark: 'done', version: OLDER.version }]);
  });

  it('a stalled promise list gives up after 15 seconds even without AbortSignal.timeout (older WebKit)', async () => {
    const staticTimeout = AbortSignal.timeout;
    AbortSignal.timeout = undefined;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.stubGlobal('fetch', vi.fn((url, options) => {
        if (String(url).includes('/promises')) {
          return new Promise((_, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
        }
        return Promise.resolve({ ok: true, json: async () => ({ customer: {}, actions: [], available: false }) });
      }));
      localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
        serviceId: service.id,
        savedAt: Date.now(),
        notes: 'Ghost ants on the slider track.',
        promiseMarks: { [PROMISES[0].id]: { mark: 'done', version: PROMISES[0].version, stillLeft: '' } },
      }));
      const onSubmit = vi.fn().mockResolvedValue({});
      await renderPanel({ onSubmit });
      fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
      await act(async () => { vi.advanceTimersByTime(15000); });
      const submit = await screen.findByRole('button', { name: /^Complete/i });
      await waitFor(() => expect(submit.disabled).toBe(false));
      await act(async () => fireEvent.click(submit));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(alert).not.toHaveBeenCalledWith('Still loading the promises you marked. Try again in a moment.');
      expect(onSubmit.mock.calls[0][1].promiseMarks).toEqual([{ id: PROMISES[0].id, mark: 'done', version: PROMISES[0].version }]);
    } finally {
      vi.useRealTimers();
      AbortSignal.timeout = staticTimeout;
    }
  });

  it('a promise list that cannot be read keeps the restored report and sends the marks for the server to check', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/promises')) throw new TypeError('Failed to fetch');
      return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
    }));
    localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: REPORT,
      generatedReportText: REPORT,
      installedReportDraft: REPORT,
      preGenerationNotes: 'Ghost ants on the slider track.',
      aiReportUsed: true,
      promiseMarks: { [PROMISES[0].id]: { mark: 'done', version: PROMISES[0].version, stillLeft: '' } },
      generationPromiseSignature: JSON.stringify([[PROMISES[0].id, 'done', PROMISES[0].version, '']]),
    }));
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    // No promise changed; the list just could not be read: the report stays.
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/promises'))).toBe(true));
    await waitFor(() => expect(notes().value).toBe(REPORT));
    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1].promiseMarks).toEqual([{ id: PROMISES[0].id, mark: 'done', version: PROMISES[0].version }]);
    expect(notes().value).toBe(REPORT);
  });

  it('a marked promise that changed since the report asks: OK sends as is, Cancel reloads the list', async () => {
    const changed = Object.assign(new Error('A promise you marked changed after the report was written (the office closed, reworded or moved it). The report may still mention it.'), { code: 'promise_marks_changed' });
    const onSubmit = vi.fn().mockRejectedValueOnce(changed).mockRejectedValueOnce(changed).mockResolvedValue({});
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    await renderPanel({ onSubmit });
    await screen.findByText('Promises we made');
    fireEvent.click(markButton('Check under the dishwasher', 'Done'));
    const promiseReads = () => fetch.mock.calls.filter(([url]) => String(url).includes('/promises')).length;
    const before = promiseReads();

    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining('A promise you marked changed')));
    await waitFor(() => expect(promiseReads()).toBeGreaterThan(before)); // Cancel reloaded the list
    expect(onSubmit).toHaveBeenCalledTimes(1);

    confirm.mockReturnValue(true);
    await act(async () => fireEvent.click(submit));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3));
    expect(onSubmit.mock.calls[2][1]).toEqual(expect.objectContaining({ promiseMarksConfirmed: true }));
  });

  it('Complete waits while restored marks are still loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/promises')) return new Promise(() => {});
      return { ok: true, json: async () => ({ customer: {}, actions: [], available: false }) };
    }));
    localStorage.setItem(`waves_completion_draft_${service.id}`, JSON.stringify({
      serviceId: service.id,
      savedAt: Date.now(),
      notes: 'Ghost ants on the slider track.',
      promiseMarks: { [PROMISES[0].id]: { mark: 'done', version: PROMISES[0].version, stillLeft: '' } },
    }));
    const onSubmit = vi.fn().mockResolvedValue({});
    await renderPanel({ onSubmit });
    fireEvent.click(await screen.findByRole('button', { name: 'Restore', exact: true }));
    const submit = await screen.findByRole('button', { name: /^Complete/i });
    await waitFor(() => expect(submit.disabled).toBe(false));
    await act(async () => fireEvent.click(submit));
    expect(alert).toHaveBeenCalledWith('Still loading the promises you marked. Try again in a moment.');
    expect(onSubmit).not.toHaveBeenCalled();
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
