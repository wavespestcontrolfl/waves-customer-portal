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
    expect(screen.getByText(/Refunds on these stops total \$30\.00/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Share of the amount above the bar (%)'), { target: { value: '16' } });
    fireEvent.change(screen.getByLabelText('Bar for each shift ($)'), { target: { value: '425.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save numbers' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/production-share/settings', expect.objectContaining({ method: 'PUT' })));
    const put = call.mock.calls.find(([path]) => path === '/production-share/settings')[1];
    expect(put.body).toEqual({ technicianId: 'tech-a', rateBps: 1600, barType: 'per_shift', barCents: 42550, callbackStopValueCents: 9500 });
  });

  it('shows refunds on shared invoices that could not be split', async () => {
    const call = vi.fn(async (path) => answerFor(path, { unallocatedRefundCents: 1200 }));
    render(<ProductionSharePanel call={call} technicians={TECHS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the production share preview' }));
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'tech-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the week' }));
    expect(await screen.findByText(/Refunds of \$12\.00 are on shared invoices/)).toBeInTheDocument();
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
});
