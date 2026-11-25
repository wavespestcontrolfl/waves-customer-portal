// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProductionSharePanel, { percentToBps } from './ProductionSharePanel';

const TECHS = [{ id: 'tech-a', name: 'Sample Alpha' }, { id: 'tech-gone', name: 'Sample Former', notW2: true }];
const PREVIEW = {
  technician: { id: 'tech-a', name: 'Sample Alpha' }, weekStart: '2026-09-14', weekEnd: '2026-09-20', shifts: 2, creditedCents: 150000,
  barCents: 80000, aboveBarCents: 70000, shareCents: 10500, configured: true, refundCents: 3000,
  settings: { id: 1, technicianId: null, fromWeek: '2026-09-07', rateBps: 1500, barType: 'per_shift', barCents: 40000, callbackStopValueCents: 9500 },
  stops: [
    { visitId: 'v1', workDate: '2026-09-14', serviceType: 'Pest Control', kind: 'priced', creditCents: 100000, reason: 'Price of the visit, before sales tax', needsReview: false, refundCents: 3000 },
    { visitId: 'v2', workDate: '2026-09-15', serviceType: 'Pest Control Re-Service', kind: 'callback_review', creditCents: 0, reason: 'No earlier completed work', needsReview: true, refundCents: 0 },
  ],
  needsReview: [{ visitId: 'v2' }],
};

afterEach(cleanup);

// The server answers for the employee and week it was asked about.
const answerFor = (path, patch = {}) => {
  const query = new URLSearchParams(path.split('?')[1]);
  return { ...PREVIEW, technician: { id: query.get('technicianId'), name: 'Sample' }, weekStart: query.get('weekStart'), ...patch };
};

describe('percentToBps', () => {
  it('reads a percent with up to 2 decimals as basis points and nothing else', () => {
    expect(percentToBps('15')).toBe(1500);
    expect(percentToBps(' 12.5 ')).toBe(1250);
    expect(percentToBps('0.05')).toBe(5);
    expect(percentToBps('15%')).toBeNull();
    expect(percentToBps('')).toBeNull();
    expect(percentToBps('1.234')).toBeNull();
  });
});

describe('Production share preview', () => {
  it('shows the week, marks stops that need review, and saves numbers as cents and basis points', async () => {
    const call = vi.fn(async (path) => (path.startsWith('/production-share/preview') ? answerFor(path) : {}));
    render(<ProductionSharePanel call={call} technicians={TECHS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
    // A former employee is not offered.
    expect(screen.queryByRole('option', { name: 'Sample Former' })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
    fireEvent.change(screen.getByLabelText('Week starting (Monday)'), { target: { value: '2026-09-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    await screen.findByLabelText('Week summary');
    expect(call).toHaveBeenCalledWith('/production-share/preview?technicianId=tech-a&weekStart=2026-09-14');
    const summary = within(screen.getByLabelText('Week summary'));
    expect(summary.getByText('$1,500.00')).toBeInTheDocument();
    expect(summary.getByText('$105.00')).toBeInTheDocument();
    expect(screen.getByText(/1 stop need review/)).toBeInTheDocument();
    expect(screen.getByText(/Needs review:/)).toBeInTheDocument();
    expect(screen.getByText(/Refunds recorded on these stops total \$30\.00/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Share of the amount above the bar (%)'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('Bar for each shift ($)'), { target: { value: '425.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save numbers' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/settings', expect.objectContaining({ method: 'PUT' })));
    const put = call.mock.calls.find(([path]) => path === '/production-share/settings')[1];
    expect(put.body).toEqual({ technicianId: 'tech-a', rateBps: 1600, barType: 'per_shift', barCents: 42550, callbackStopValueCents: 9500 });
    // the words no longer say a pay run pays nothing: the preview is an estimate, and a pay run uses these numbers when it is on
    expect(await screen.findByText(/Saved\. A pay run uses these numbers/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/pays nothing yet|Nothing is paid|not paid/i);
    expect(screen.getByText(/This is an estimate/)).toBeInTheDocument();
    expect(screen.getByText('Share (estimate)')).toBeInTheDocument();
  });

  it('shows refunds on shared invoices that could not be split', async () => {
    const call = vi.fn(async (path) => answerFor(path, { unallocatedRefundCents: 1200 }));
    render(<ProductionSharePanel call={call} technicians={TECHS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    expect(await screen.findByText(/Refunds of \$12\.00 are on shared invoices/)).toBeInTheDocument();
  });

  it('shows a refund-flagged stop with its reason and the credit box the owner already has', async () => {
    const flagged = {
      visitId: 'v9', workDate: '2026-09-16', serviceType: 'Pest Control', kind: 'refund_flagged', creditCents: 0, needsReview: true, refundCents: 1000,
      reason: 'A refund is recorded on this visit. Set its credit in the production share preview.', stopRevision: 'rev9', refundSignals: ['pay:x:1000'],
    };
    const call = vi.fn(async (path) => answerFor(path, { stops: [flagged], needsReview: [flagged] }));
    render(<ProductionSharePanel call={call} technicians={TECHS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    expect(await screen.findByText('Refund recorded')).toBeInTheDocument();
    expect(screen.getByText(/A refund is recorded on this visit\. Set its credit/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Credit ($)'), { target: { value: '90' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Refund was $10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set credit' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', expect.objectContaining({ method: 'PUT' })));
    expect(call.mock.calls.find(([path]) => path === '/production-share/stop-override')[1].body)
      .toMatchObject({ visitId: 'v9', creditCents: 9000, stopRevision: 'rev9' });
  });

  it('names a new refund as the reason an owner credit is no longer used, and lets him clear that credit', async () => {
    const aside = {
      visitId: 'v8', workDate: '2026-09-16', serviceType: 'Pest Control', kind: 'owner_override_refund_changed', creditCents: 0, needsReview: true, refundCents: 2000,
      reason: 'A new refund is recorded on this visit since the owner set its credit: clear that credit, then set it again in the production share preview.', overrideRevision: 'ov8',
    };
    const call = vi.fn(async (path) => answerFor(path, { stops: [aside], needsReview: [aside] }));
    render(<ProductionSharePanel call={call} technicians={TECHS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    expect(await screen.findByText('New refund since you set it')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the old credit' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', expect.objectContaining({ method: 'DELETE' })));
    expect(call.mock.calls.find(([path]) => path === '/production-share/stop-override')[1].body).toMatchObject({ visitId: 'v8', revision: 'ov8' });
  });

  describe('refunds on paid stops', () => {
    const toSet = { checkId: 'check-1', visitId: 'v-paid', workDate: '2026-09-08', paidWeekStart: '2026-09-07', creditCents: 100000, newSignals: ['pay:x:3000'], answerRevision: 'none', signalRevision: 'sig-1', reason: 'new', previousCents: null,
      visit: { serviceType: 'Pest Control', scheduledDate: '2026-09-08', windowDisplay: '9-11 AM', completedAt: '2026-09-08T15:10:00.000Z' } };
    const open = async (patch) => {
      const call = vi.fn(async (path) => (path.startsWith('/production-share/preview') ? answerFor(path, patch) : {}));
      render(<ProductionSharePanel call={call} technicians={TECHS} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
      fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
      fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
      await screen.findByLabelText('Refunds on paid stops');
      return call;
    };

    it('lists a paid stop with a new refund and saves the total in cents with the signals it saw; refuses more than the credit paid', async () => {
      const call = await open({ takeBackToSet: [toSet], takeBackAnswers: [], takeBacks: [] });
      expect(screen.getByText('New refund')).toBeInTheDocument();
      const box = screen.getByLabelText('Take back ($, up to the credit paid)');
      fireEvent.change(box, { target: { value: '1000.01' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(screen.getByText(/More than the \$1,000\.00 paid/)).toBeInTheDocument();
      fireEvent.change(box, { target: { value: '300' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/refund-take-back', expect.objectContaining({ method: 'PUT' })));
      expect(call.mock.calls.find(([path]) => path === '/production-share/refund-take-back')[1].body)
        .toEqual({ checkId: 'check-1', visitId: 'v-paid', cents: 30000, signalRevision: 'sig-1', answerRevision: 'none' });
      // The week is read again after a save.
      await waitFor(() => expect(call.mock.calls.filter(([path]) => path.startsWith('/production-share/preview')).length).toBe(2));
    });

    it('tells paid visits apart: id, service, window, completion time and a link to the day', async () => {
      await open({ takeBackToSet: [toSet], takeBackAnswers: [], takeBacks: [] });
      const reference = screen.getByText(/Visit v-paid · Pest Control · 9-11 AM · done /).closest('p');
      expect(within(reference).getByRole('link', { name: 'Open the day' })).toHaveAttribute('href', '/admin/schedule?date=2026-09-08');
    });

    it('shows the previous total and says nothing more is taken when an answered refund changed', async () => {
      const answered = { ...toSet, cents: 30000, signals: ['pay:x:3000'], newSignals: [] };
      await open({ takeBackToSet: [{ ...toSet, newSignals: [], reason: 'changed', previousCents: 30000, answerRevision: '7:t' }], takeBackAnswers: [{ ...answered, answerRevision: '7:t' }], takeBacks: [] });
      expect(screen.getByText('A refund you answered changed')).toBeInTheDocument();
      expect(screen.getByText(/Previous total \$300\.00\. Nothing more is taken from this stop until you save a new total\./)).toBeInTheDocument();
      expect(screen.getByLabelText('Take back ($, up to the credit paid)')).toHaveValue('');
    });

    it('keeps an answered stop with the total he set, lets him clear it, and says what was taken or given back', async () => {
      const answered = { ...toSet, cents: 30000, note: null, signals: ['pay:x:3000'], newSignals: [], answerRevision: '7:2026-09-20T10:00:00.000001' };
      const call = await open({
        takeBackToSet: [], takeBackAnswers: [answered], owedTakeBackCents: 30000,
        takeBacks: [
          { sourceCheckId: 'check-1', visitId: 'v-paid', workDate: '2026-09-08', paidWeekStart: '2026-09-07', cents: 20000 },
          { sourceCheckId: 'check-2', visitId: 'v-other', workDate: '2026-09-09', paidWeekStart: '2026-09-07', cents: -5000 },
          { sourceCheckId: 'check-3', visitId: 'v-zero', workDate: '2026-09-10', paidWeekStart: '2026-09-07', cents: 0 },
        ],
      });
      expect(screen.getByText('Answered')).toBeInTheDocument();
      expect(screen.getByLabelText('Take back ($, up to the credit paid)')).toHaveValue('300.00');
      expect(screen.getByText('Refund taken back from a paid week: $200.00 (visit of Sep 8, 2026)')).toBeInTheDocument();
      expect(screen.getByText(/Refund given back to a paid week: \$50\.00/)).toBeInTheDocument();
      expect(screen.queryByText(/Sep 10, 2026/)).toBeNull(); // the 0-cent entry only keeps a dependency
      expect(screen.getByText(/Still owed and not yet taken: \$100\.00/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/refund-take-back', expect.objectContaining({ method: 'DELETE' })));
      expect(call.mock.calls.find(([path]) => path === '/production-share/refund-take-back')[1].body).toEqual({ checkId: 'check-1', visitId: 'v-paid', signalRevision: 'sig-1', answerRevision: '7:2026-09-20T10:00:00.000001' });
    });

    it('shows no section for a week with no refunds on paid stops', async () => {
      const call = vi.fn(async (path) => answerFor(path, { takeBackToSet: [], takeBackAnswers: [], takeBacks: [] }));
      render(<ProductionSharePanel call={call} technicians={TECHS} />);
      fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
      fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
      fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
      await screen.findByLabelText('Week summary');
      expect(screen.queryByLabelText('Refunds on paid stops')).toBeNull();
    });
  });

  it('says so when no numbers are set, and shows a server refusal', async () => {
    const call = vi.fn(async (path) => {
      if (path.startsWith('/production-share/preview')) return answerFor(path, { configured: false, barCents: null, settings: null, shareCents: 0, needsReview: [], refundCents: 0, stops: [] });
      throw new Error('This action is limited to the owner account.');
    });
    render(<ProductionSharePanel call={call} technicians={TECHS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    await screen.findByLabelText('Week summary');
    expect(screen.getAllByText(/No numbers are set/).length).toBeGreaterThan(0);
    expect(screen.getByText('No completed stops in this week.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save numbers' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Share of the amount above the bar (%)'), { target: { value: '15' } });
    fireEvent.change(screen.getByLabelText('Bar for each shift ($)'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText("Average value of one stop, for a callback on another employee's work ($)"), { target: { value: '95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save numbers' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('limited to the owner account');
  });

  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
  const show = async (call, id = 'tech-a', week = '2026-09-14') => {
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: id } });
    fireEvent.change(screen.getByLabelText('Week starting (Monday)'), { target: { value: week } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    await screen.findByLabelText('Week summary');
  };

  it('drops the week on screen, with its numbers form, as soon as the employee or the week changes, including Week before', async () => {
    const call = vi.fn(async (path) => answerFor(path));
    render(<ProductionSharePanel call={call} technicians={[...TECHS, { id: 'tech-b', name: 'Sample Bravo' }]} />);
    open();
    await show(call);
    expect(screen.getByRole('form', { name: 'Production share numbers' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Week before' }));
    expect(screen.queryByLabelText('Week summary')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Production share numbers' })).toBeNull();
    expect(screen.getByLabelText('Week starting (Monday)')).toHaveValue('2026-09-07');
    // Showing it again loads the new week; an answer for another week is not shown for this one.
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    expect(await screen.findByLabelText('Week summary')).toBeInTheDocument();
    expect(call).toHaveBeenLastCalledWith('/production-share/preview?technicianId=tech-a&weekStart=2026-09-07');
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-b' } });
    expect(screen.queryByLabelText('Week summary')).toBeNull();
  });

  it('ignores an answer that arrives after the selection changed, and never shows a different employee\'s week', async () => {
    let release;
    const call = vi.fn(() => new Promise((resolve) => { release = () => resolve(PREVIEW); }));
    render(<ProductionSharePanel call={call} technicians={[...TECHS, { id: 'tech-b', name: 'Sample Bravo' }]} />);
    open();
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
    fireEvent.change(screen.getByLabelText('Week starting (Monday)'), { target: { value: '2026-09-14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-b' } });
    await act(async () => { release(); });
    expect(screen.queryByLabelText('Week summary')).toBeNull();
    // The answer is for tech-a and week 09-14: with tech-b selected it is never shown, even when it was the newest answer.
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    await act(async () => { release(); });
    expect(screen.queryByLabelText('Week summary')).toBeNull();
  });

  it('saves the numbers for the employee and week that were loaded', async () => {
    const call = vi.fn(async (path) => (path.startsWith('/production-share/preview') ? answerFor(path) : {}));
    render(<ProductionSharePanel call={call} technicians={TECHS} />);
    open();
    await show(call);
    fireEvent.click(screen.getByRole('button', { name: 'Save numbers' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/settings', expect.anything()));
    const put = call.mock.calls.find(([path]) => path === '/production-share/settings')[1];
    expect(put.body.technicianId).toBe('tech-a');
    await waitFor(() => expect(call).toHaveBeenLastCalledWith('/production-share/preview?technicianId=tech-a&weekStart=2026-09-14'));
  });

  it('does not refresh the preview after a save when the employee or week changed while it was saving', async () => {
    let finishSave;
    const call = vi.fn((path) => {
      if (path === '/production-share/settings') return new Promise((resolve) => { finishSave = () => resolve({}); });
      return Promise.resolve(answerFor(path));
    });
    render(<ProductionSharePanel call={call} technicians={[...TECHS, { id: 'tech-b', name: 'Sample Bravo' }]} />);
    open();
    await show(call);
    fireEvent.click(screen.getByRole('button', { name: 'Save numbers' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/settings', expect.anything()));
    const previews = () => call.mock.calls.filter(([path]) => path.startsWith('/production-share/preview')).length;
    expect(previews()).toBe(1);
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-b' } });
    await act(async () => { finishSave(); });
    // The save finished for tech-a: nothing is loaded for tech-b, and nothing is shown for either.
    expect(previews()).toBe(1);
    expect(screen.queryByLabelText('Week summary')).toBeNull();
  });

  describe('the credit the owner sets for a stop', () => {
    const forms = (stops) => async () => {
      const call = vi.fn(async (path) => (path.startsWith('/production-share/preview') ? answerFor(path, { stops }) : {}));
      render(<ProductionSharePanel call={call} technicians={TECHS} />);
      open();
      await show(call);
      return call;
    };

    it('a review row gets a Set credit form that sends cents and the reason, then reloads the week', async () => {
      const call = await forms(PREVIEW.stops)();
      // only the review stop has the form
      expect(screen.getAllByRole('form', { name: 'Set the credit of this stop' })).toHaveLength(1);
      const set = screen.getByRole('button', { name: 'Set credit' });
      expect(set).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Credit ($)'), { target: { value: '45.50' } });
      expect(set).toBeDisabled(); // a reason is required
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' checked the invoice ' } });
      fireEvent.click(set);
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', expect.anything()));
      expect(call.mock.calls.find(([path]) => path === '/production-share/stop-override')[1]).toEqual({
        method: 'PUT', body: { technicianId: 'tech-a', visitId: 'v2', weekStart: '2026-09-14', creditCents: 4550, reason: 'checked the invoice', stopRevision: '' },
      });
      await waitFor(() => expect(call).toHaveBeenLastCalledWith('/production-share/preview?technicianId=tech-a&weekStart=2026-09-14'));
    });

    it('shows the server refusal (a paid week) and keeps the form', async () => {
      const call = vi.fn(async (path) => {
        if (path === '/production-share/stop-override') throw new Error('This week is already paid.');
        return answerFor(path);
      });
      render(<ProductionSharePanel call={call} technicians={TECHS} />);
      open();
      await show(call);
      fireEvent.change(screen.getByLabelText('Credit ($)'), { target: { value: '10' } });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'why' } });
      fireEvent.click(screen.getByRole('button', { name: 'Set credit' }));
      expect(await screen.findByText('This week is already paid.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set credit' })).toBeInTheDocument();
    });

    it('AUDIT :249: a change finished after the employee or week was switched does not reload the old answer', async () => {
      let finish;
      const call = vi.fn((path) => {
        if (path === '/production-share/stop-override') return new Promise((resolve) => { finish = () => resolve({}); });
        return Promise.resolve(answerFor(path));
      });
      render(<ProductionSharePanel call={call} technicians={[...TECHS, { id: 'tech-b', name: 'Sample Bravo' }]} />);
      open();
      await show(call);
      fireEvent.change(screen.getByLabelText('Credit ($)'), { target: { value: '10' } });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'why' } });
      fireEvent.click(screen.getByRole('button', { name: 'Set credit' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', expect.anything()));
      const previews = () => call.mock.calls.filter(([path]) => path.startsWith('/production-share/preview')).length;
      expect(previews()).toBe(1);
      fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-b' } });
      await act(async () => { finish(); });
      expect(previews()).toBe(1);
      expect(screen.queryByLabelText('Week summary')).toBeNull();
    });

    it('a reassigned stop shows Clear the old credit; a stop with no closeout record shows no form', async () => {
      const call = await forms([
        { visitId: 'v5', workDate: '2026-09-15', overrideRevision: 'rev-5', serviceType: 'Pest Control', kind: 'owner_override_reassigned', creditCents: 0, reason: 'reassigned', needsReview: true, refundCents: 0 },
        { visitId: 'v6', workDate: '2026-09-16', serviceType: 'Pest Control', kind: 'unverified', creditCents: 0, reason: 'No closeout', needsReview: true, refundCents: 0 },
      ])();
      expect(screen.queryByRole('form', { name: 'Set the credit of this stop' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Clear the old credit' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', {
        method: 'DELETE', body: { technicianId: 'tech-a', visitId: 'v5', weekStart: '2026-09-14', revision: 'rev-5' },
      }));
    });

    it('AUDIT :257: a review row names its visit: short id, time, address and a link to its scheduled day (not the pay date) before the Set credit form', async () => {
      await forms([
        { visitId: '3fa85f64-5717-4562-b3fc-2c963f66afa6', workDate: '2026-09-15', scheduledDate: '2026-09-14', completedAt: '2026-09-15T18:15:00Z', address: '123 Example St 34202',
          serviceType: 'Pest Control', kind: 'unpriced', creditCents: 0, reason: 'No price', needsReview: true, refundCents: 0 },
      ])();
      const reference = screen.getByLabelText('Visit reference');
      expect(reference).toHaveTextContent('Visit 3fa85f64 · 2:15 PM · 123 Example St 34202');
      expect(within(reference).getByRole('link', { name: 'Open the day' })).toHaveAttribute('href', '/admin/schedule?date=2026-09-14');
      expect(reference.compareDocumentPosition(screen.getByRole('form', { name: 'Set the credit of this stop' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('AUDIT :160: an unconfirmed or already-paid review row shows its visit and says what to do instead of a form', async () => {
      await forms([
        { visitId: 'v9', workDate: '2026-09-15', scheduledDate: '2026-09-15', address: '9 Example Rd 34202', serviceType: 'Pest Control', kind: 'unverified', creditCents: 0, reason: 'No closeout record', needsReview: true, refundCents: 0 },
        { visitId: 'v10', workDate: '2026-09-16', scheduledDate: '2026-09-16', serviceType: 'Pest Control', kind: 'already_paid', creditCents: 0, reason: 'Already paid in the week of 2026-09-07: a pay run already credited this visit.', needsReview: true, refundCents: 0 },
      ])();
      expect(screen.queryByRole('form', { name: 'Set the credit of this stop' })).toBeNull();
      const references = screen.getAllByLabelText('Visit reference');
      expect(references).toHaveLength(2);
      expect(references[0]).toHaveTextContent('Visit v9 · 9 Example Rd 34202');
      expect(screen.getByText(/Fix the closeout first/)).toBeInTheDocument();
      expect(screen.getByText(/Already paid in the week of Sep 7, 2026\. Its credit cannot change here\./)).toBeInTheDocument();
    });

    it('AUDIT :126: a row with no scheduled day offers no Open the day link (the pay work date is not the schedule day)', async () => {
      await forms([
        { visitId: 'v8', workDate: '2026-09-15', serviceType: 'Pest Control', kind: 'unpriced', creditCents: 0, reason: 'No price', needsReview: true, refundCents: 0 },
      ])();
      expect(screen.getByLabelText('Visit reference')).toHaveTextContent('Visit v8');
      expect(screen.queryByRole('link', { name: 'Open the day' })).toBeNull();
    });

    it('AUDIT :259: a save or clear reloads the week while the employee and week are unchanged, even after another load started', async () => {
      let finish;
      const call = vi.fn((path) => {
        if (path === '/production-share/stop-override') return new Promise((resolve) => { finish = () => resolve({}); });
        return Promise.resolve(answerFor(path));
      });
      render(<ProductionSharePanel call={call} technicians={TECHS} />);
      open();
      await show(call);
      const previews = () => call.mock.calls.filter(([path]) => path.startsWith('/production-share/preview')).length;
      fireEvent.change(screen.getByLabelText('Credit ($)'), { target: { value: '10' } });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'why' } });
      fireEvent.click(screen.getByRole('button', { name: 'Set credit' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', expect.anything()));
      // the owner reloads the same week while the save is on its way: that is a new request, not a new selection
      fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
      await waitFor(() => expect(previews()).toBe(2));
      await act(async () => { finish(); });
      await waitFor(() => expect(previews()).toBe(3));
    });

    it('a stop whose closeout changed since the owner set its credit shows Clear and sends DELETE', async () => {
      const call = await forms([
        { visitId: 'v7', workDate: '2026-09-15', overrideRevision: 'rev-7', serviceType: 'Pest Control', kind: 'owner_override_closeout_changed', creditCents: 0, reason: 'The closeout of this stop changed', needsReview: true, refundCents: 0 },
      ])();
      expect(screen.queryByRole('form', { name: 'Set the credit of this stop' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Clear the old credit' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', {
        method: 'DELETE', body: { technicianId: 'tech-a', visitId: 'v7', weekStart: '2026-09-14', revision: 'rev-7' },
      }));
    });

    it('AUDIT :1210: Set credit sends the revision of the stop as the page showed it', async () => {
      const call = await forms([
        { visitId: 'v12', workDate: '2026-09-15', stopRevision: '0123456789abcdef', serviceType: 'Pest Control', kind: 'invoice_paid_elsewhere', creditCents: 0,
          reason: 'This invoice also covers a visit paid', needsReview: true, refundCents: 0 },
      ])();
      fireEvent.change(screen.getByLabelText('Credit ($)'), { target: { value: '12' } });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'why' } });
      fireEvent.click(screen.getByRole('button', { name: 'Set credit' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', {
        method: 'PUT', body: { technicianId: 'tech-a', visitId: 'v12', weekStart: '2026-09-14', creditCents: 1200, reason: 'why', stopRevision: '0123456789abcdef' },
      }));
    });

    it('AUDIT :292: a stop whose revision changed on reload resets the typed amount and reason', async () => {
      const row = (stopRevision) => ({ visitId: 'v13', workDate: '2026-09-15', stopRevision, serviceType: 'Pest Control', kind: 'unpriced', creditCents: 0, reason: 'No price', needsReview: true, refundCents: 0 });
      let revision = 'rev-a';
      const call = vi.fn(async (path) => (path.startsWith('/production-share/preview') ? answerFor(path, { stops: [row(revision)] }) : {}));
      render(<ProductionSharePanel call={call} technicians={TECHS} />);
      open();
      await show(call);
      fireEvent.change(screen.getByLabelText('Credit ($)'), { target: { value: '33' } });
      fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'typed' } });
      // the stop changed behind the page: a reload brings another revision, and the old typing must not stay in the form
      revision = 'rev-b';
      fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
      await waitFor(() => expect(call.mock.calls.filter(([path]) => path.startsWith('/production-share/preview'))).toHaveLength(2));
      await waitFor(() => expect(screen.getByLabelText('Credit ($)')).toHaveValue(''));
      expect(screen.getByLabelText('Reason')).toHaveValue('');
    });

    it('a stop that was paid elsewhere since the owner set its credit shows Clear and sends DELETE with the revision', async () => {
      const call = await forms([
        { visitId: 'v11', workDate: '2026-09-15', overrideRevision: 'rev-11', serviceType: 'Pest Control', kind: 'owner_override_conflict_changed', creditCents: 0,
          reason: 'This stop, its invoice or its package was paid elsewhere since the owner set its credit', needsReview: true, refundCents: 0 },
      ])();
      expect(screen.queryByRole('form', { name: 'Set the credit of this stop' })).toBeNull();
      expect(screen.getByText('Paid elsewhere since you set it')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Clear the old credit' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', {
        method: 'DELETE', body: { technicianId: 'tech-a', visitId: 'v11', weekStart: '2026-09-14', revision: 'rev-11' },
      }));
    });

    it('a stop the owner set shows Clear; a stop a pay run already paid shows no form', async () => {
      const call = await forms([
        { visitId: 'v3', workDate: '2026-09-15', overrideRevision: 'rev-3', serviceType: 'Pest Control', kind: 'owner_set', creditCents: 4550, reason: 'Set by the owner: checked', needsReview: false, refundCents: 0 },
        { visitId: 'v4', workDate: '2026-09-16', serviceType: 'Pest Control', kind: 'already_paid', creditCents: 0, reason: 'Already paid in the week of 2026-09-07', needsReview: true, refundCents: 0 },
      ])();
      expect(screen.queryByRole('form', { name: 'Set the credit of this stop' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Clear the credit I set' }));
      await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/stop-override', {
        method: 'DELETE', body: { technicianId: 'tech-a', visitId: 'v3', weekStart: '2026-09-14', revision: 'rev-3' },
      }));
    });
  });
});
