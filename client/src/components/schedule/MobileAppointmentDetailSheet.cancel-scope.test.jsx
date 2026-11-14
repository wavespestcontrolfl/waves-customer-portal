// @vitest-environment jsdom
/**
 * Cancel scope on the mobile sheet: a recurring visit offers the same
 * this_only / following / series choice the desktop sidebar and the
 * Edit-appointment modal send, and the chosen scope reaches BOTH the
 * card-hold fee prompt and the dispatch status request. A one-off visit
 * never shows the picker and always sends this_only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./MobileCustomerDetailSheet', () => ({ default: () => null }));
// Quick Move: a committed move that stays open on a warning, a clean move, and a plain dismiss.
vi.mock('./RainOutSheet', () => ({ default: ({ onClose, onDone }) => (
  <div>
    Quick Move sheet
    <button type="button" onClick={() => onDone({ movedCount: 1, failedCount: 0, notTexted: true, overlapCount: 0 })}>Move, not texted</button>
    <button type="button" onClick={() => onDone({ movedCount: 1, failedCount: 0, notTexted: false, overlapCount: 0 })}>Move, clean</button>
    <button type="button" onClick={onClose}>Dismiss Quick Move</button>
  </div>
) }));
vi.mock('./EstimateProvenanceCard', () => ({ default: () => null }));
vi.mock('../../hooks/useCustomerCards', () => ({
  useCustomerCards: () => ({ cards: [], loading: false, error: null }),
}));
vi.mock('../../lib/cardHoldCancel', () => ({
  confirmCardHoldFeeChoice: vi.fn(async () => ({ proceed: true, waiveCardHoldFee: false })),
  fetchCardHoldCancelPreview: vi.fn(async () => null),
}));

import { confirmCardHoldFeeChoice } from '../../lib/cardHoldCancel';
import MobileAppointmentDetailSheet from './MobileAppointmentDetailSheet';

window.scrollTo = vi.fn();

const baseService = {
  id: 55,
  customerId: 9,
  customerName: 'Test Customer 9',
  serviceType: 'Quarterly Pest Control',
  scheduledDate: '2026-09-10',
  scheduledTime: '10:00',
  address: '123 Palm Ave',
  status: 'confirmed',
};

function statusCall() {
  const call = global.fetch.mock.calls.find(([url, opts]) => /\/admin\/dispatch\/55\/status$/.test(url) && opts?.method === 'PUT');
  return call ? JSON.parse(call[1].body) : null;
}

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  confirmCardHoldFeeChoice.mockClear();
});
afterEach(cleanup);

describe('MobileAppointmentDetailSheet cancel scope', () => {
  it('hides the scope picker on a one-off visit and sends this_only', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: false }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(screen.queryByText('Apply changes to')).toBeNull();
    fireEvent.click(screen.getByText('Confirm cancellation'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall().scope).toBe('this_only');
    expect(confirmCardHoldFeeChoice).toHaveBeenCalledWith(55, { scope: 'this_only' });
  });

  // A technician login (the tech portal passes adminActions={false}): the
  // status route answers 403 to a non-admin following/series cancel, so the
  // sheet offers only this appointment, even on a recurring visit.
  it('a technician login sees no series scopes on a recurring visit and sends this_only', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} adminActions={false} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(screen.queryByText('Apply changes to')).toBeNull();
    fireEvent.click(screen.getByText('Confirm cancellation'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall().scope).toBe('this_only');
  });

  // Opened over a Fast Complete sheet (which drops its own focus trap while
  // suspended) or a schedule row: the shared modal contract focuses the
  // named dialog itself before Tab advances to its first control.
  it('takes focus on open, on its named dialog', () => {
    render(<MobileAppointmentDetailSheet service={baseService} onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Appointment details' }));
  });

  // After a move that committed but kept Quick Move open on a warning, this sheet's row is stale: dismissing the
  // warning closes Details too, so no second move (or text) can start from the old row.
  it('dismissing a committed Quick Move warning closes Details; a dismiss with no move does not', () => {
    const onClose = vi.fn();
    const onRescheduled = vi.fn();
    // Quick Move is offered on today's visits only.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    render(<MobileAppointmentDetailSheet service={{ ...baseService, scheduledDate: today }} onClose={onClose} onRescheduled={onRescheduled} />);
    fireEvent.click(screen.getByText('Quick Move Appointment'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Quick Move' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Quick Move Appointment'));
    fireEvent.click(screen.getByRole('button', { name: 'Move, not texted' }));
    expect(onRescheduled).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Quick Move sheet')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Quick Move' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not let Escape close Details from under Quick Move', () => {
    const onClose = vi.fn();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    render(
      <MobileAppointmentDetailSheet
        service={{ ...baseService, scheduledDate: today }}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByText('Quick Move Appointment'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Quick Move sheet')).toBeTruthy();
  });

  it('a technician login gets no Edit or Book next (both save through admin-only routes)', () => {
    const { unmount } = render(<MobileAppointmentDetailSheet service={baseService} onClose={() => {}} />);
    expect(screen.getByLabelText('Edit appointment')).toBeTruthy();
    expect(screen.getByText('Book next appointment')).toBeTruthy();
    unmount();
    render(<MobileAppointmentDetailSheet service={baseService} adminActions={false} onClose={() => {}} />);
    expect(screen.queryByLabelText('Edit appointment')).toBeNull();
    expect(screen.queryByText('Book next appointment')).toBeNull();
  });

  it('offers the three scopes on a recurring visit and defaults to this_only', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(screen.getByText('Apply changes to')).toBeTruthy();
    expect(screen.getByLabelText('This appointment only').checked).toBe(true);
    fireEvent.click(screen.getByText('Confirm cancellation'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall().scope).toBe('this_only');
  });

  it('offers the series scopes on a legacy row that carries only recurringPattern', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: null, recurringPattern: 'quarterly' }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(screen.getByText('Apply changes to')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('All appointments in series'));
    fireEvent.click(screen.getByText('Confirm cancellations'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall().scope).toBe('series');
  });

  it.each([
    ['This and following appointments', 'following'],
    ['All appointments in series', 'series'],
  ])('sends %s as scope %s to the fee prompt and the request', async (label, scope) => {
    const onCancelled = vi.fn();
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} onCancelled={onCancelled} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(screen.getByText('Confirm cancellations'));
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(confirmCardHoldFeeChoice).toHaveBeenCalledWith(55, { scope });
    expect(statusCall()).toMatchObject({ status: 'cancelled', scope, notifyCustomer: true });
  });

  it('adds the series caveat to the fee notice once a series scope is chosen', async () => {
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    const caveat = /judged on their own saved cards/;
    await waitFor(() => expect(screen.getByText(/Couldn't check the saved card/)).toBeTruthy());
    expect(screen.queryByText(caveat)).toBeNull();
    fireEvent.click(screen.getByLabelText('This and following appointments'));
    await waitFor(() => expect(screen.getByText(caveat)).toBeTruthy());
  });

  it('does not send when the fee prompt is declined', async () => {
    confirmCardHoldFeeChoice.mockResolvedValueOnce({ proceed: false, waiveCardHoldFee: false });
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    fireEvent.click(screen.getByLabelText('All appointments in series'));
    fireEvent.click(screen.getByText('Confirm cancellations'));
    await waitFor(() => expect(confirmCardHoldFeeChoice).toHaveBeenCalledTimes(1));
    expect(statusCall()).toBeNull();
  });
});

// Owner decision 2026-11-13: the office can skip one plan visit. A skip marks
// the visit skipped, books no make-up visit and sends no customer text. The
// cancel panel shows the same SkipVisitOption the desktop Cancel window shows;
// the panel's own cancel controls are unchanged.
describe('MobileAppointmentDetailSheet skip this visit', () => {
  const eligible = { eligible: true, code: 'ok', message: '', nextVisitDate: '2027-02-22', lawnRound: null };
  const previewAsked = () => global.fetch.mock.calls.some(([url]) => /\/admin\/dispatch\/55\/card-hold\?skip=1$/.test(url));
  // The cancel preview answers `skip`; every other request keeps the file's default empty answer.
  function answerPreview(skip, statusReply = { ok: true, json: async () => ({}) }) {
    global.fetch = vi.fn(async (url, opts) => {
      if (/card-hold\?skip=1$/.test(url)) return { ok: true, json: async () => ({ skip }) };
      if (/\/status$/.test(url) && opts?.method === 'PUT') return statusReply;
      return { ok: true, json: async () => ({}) };
    });
  }

  it('the office skips an eligible plan visit: next visit shown, one request, no fee step, the sheet closes', async () => {
    answerPreview(eligible);
    const onCancelled = vi.fn();
    const onClose = vi.fn();
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={onClose} onCancelled={onCancelled} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    const button = await screen.findByRole('button', { name: 'Skip this visit' });
    expect(screen.getByText('Next visit: Mon, Feb 22, 2027')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(statusCall()).toEqual({ status: 'skipped', notes: 'Skipped from appointment sheet' });
    expect(confirmCardHoldFeeChoice).not.toHaveBeenCalled();
  });

  it('a refused skip shows the server sentence and keeps the panel open', async () => {
    const refusal = 'This visit has an invoice, a card or a linked visit on it. Cancel it instead.';
    answerPreview(eligible, { ok: false, status: 409, json: async () => ({ error: refusal, code: 'skip_has_money_or_links' }) });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onCancelled = vi.fn();
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} onCancelled={onCancelled} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip this visit' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(`Failed to skip visit: ${refusal}`));
    expect(onCancelled).not.toHaveBeenCalled();
    expect(screen.getByText('Confirm cancellation')).toBeTruthy();
    alert.mockRestore();
  });

  it('a paid visit shows the sentence to move it and no skip button; a cancel is sent as before', async () => {
    const message = 'This visit is paid for already. Move it to a new date instead of skipping it.';
    answerPreview({ eligible: false, code: 'prepaid', message, nextVisitDate: null, lawnRound: null });
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip this visit' })).toBeNull();
    fireEvent.click(screen.getByText('Confirm cancellation'));
    await waitFor(() => expect(statusCall()).not.toBeNull());
    expect(statusCall()).toMatchObject({ status: 'cancelled', scope: 'this_only' });
    expect(confirmCardHoldFeeChoice).toHaveBeenCalledWith(55, { scope: 'this_only' });
  });

  it('a technician login never asks for the verdict and never shows the choice', async () => {
    answerPreview(eligible);
    render(<MobileAppointmentDetailSheet service={{ ...baseService, isRecurring: true }} adminActions={false} onClose={() => {}} />);
    fireEvent.click(screen.getByText('Cancel appointment'));
    await screen.findByText('Client booking notifications');
    expect(previewAsked()).toBe(false);
    expect(screen.queryByRole('button', { name: 'Skip this visit' })).toBeNull();
  });
});
