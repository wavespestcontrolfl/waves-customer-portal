// @vitest-environment jsdom
// Termite annual plan — slice 6a, My Plan tab renewal card (customer online
// decline). GATE_TERMITE_ANNUAL_PLAN + GATE_CANCEL_FLOW_V2 resolve server-
// side; the client only renders what GET /property/termite-annual-plan
// answers.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Any api method not explicitly mocked returns a forever-pending promise, so
// untested widgets sit in their loading states instead of crashing the render
// (same convention as PortalPage.truth-copy.test.jsx).
vi.mock('../utils/api', () => {
  const target = {};
  const proxy = new Proxy(target, {
    get: (obj, prop) => {
      if (typeof prop !== 'string') return obj[prop];
      if (!(prop in obj)) obj[prop] = vi.fn(() => new Promise(() => {}));
      return obj[prop];
    },
    set: (obj, prop, value) => { obj[prop] = value; return true; },
  });
  return { default: proxy };
});

import api from '../utils/api';
import { MyPlanTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null, property: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getNextService.mockResolvedValue({ next: null });
  api.getSchedule.mockResolvedValue({ upcoming: [] });
  api.getServices.mockResolvedValue({ services: [] });
  api.getAutopay.mockResolvedValue({ state: 'disabled' });
  api.getStationMap.mockResolvedValue({ available: false });
  api.getLawnHealth.mockResolvedValue({ available: false });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('termite annual plan renewal card', () => {
  it('renders nothing when the gate is off / no term is available', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({ available: false, reason: 'disabled' });
    render(<MyPlanTab customer={customer} />);
    await waitFor(() => expect(api.getTermiteAnnualPlan).toHaveBeenCalled());
    expect(screen.queryByText('Termite Annual Plan')).not.toBeInTheDocument();
  });

  it('shows the renewal date, fee, and a decline control for a live undecided term', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true }],
    });
    render(<MyPlanTab customer={customer} />);
    expect(await screen.findByText('Termite Annual Plan')).toBeInTheDocument();
    expect(screen.getByText('May 20, 2027')).toBeInTheDocument();
    expect(screen.getByText(/\$450\.00 renewal fee/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t renew my plan' })).toBeInTheDocument();
  });

  // codex round-1 P1: a multi-property account can carry more than one
  // overlapping termite annual term — one card per term, each independently
  // controlled.
  it('renders one card per applicable term for a multi-property account', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [
        { id: 'term-a', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true },
        { id: 'term-b', termEnd: '2027-08-01', prepayAmount: 600, declined: false, canDecline: true },
      ],
    });
    render(<MyPlanTab customer={customer} />);
    expect(await screen.findAllByText('Termite Annual Plan')).toHaveLength(2);
    expect(screen.getByText('May 20, 2027')).toBeInTheDocument();
    expect(screen.getByText('August 1, 2027')).toBeInTheDocument();
    const declineButtons = screen.getAllByRole('button', { name: 'Don’t renew my plan' });
    expect(declineButtons).toHaveLength(2);

    api.declineTermiteAnnualPlanRenewal.mockResolvedValue({
      ok: true, termId: 'term-b', termEnd: '2027-08-01', prepayAmount: 600, alreadyDeclined: false,
    });
    fireEvent.click(declineButtons[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    // Declining the SECOND term passes its own id, and leaves the first
    // term's card untouched (still offering its own decline control).
    await waitFor(() => expect(api.declineTermiteAnnualPlanRenewal).toHaveBeenCalledWith('term-b'));
    expect(screen.getAllByRole('button', { name: 'Don’t renew my plan' })).toHaveLength(1);
  });

  // Pre-push audit P1: a multi-property account's cards were identical —
  // each card names its property, and the decline confirmation names the
  // property being declined.
  it('names each card\'s property and asks "Don’t renew the plan at <address>?" in the confirm step', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [
        {
          id: 'term-a', propertyLabel: '12 Palm Ave, Bradenton, FL 34202', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true,
        },
        {
          id: 'term-b', propertyLabel: '400 Gulf Dr, Unit 3, Holmes Beach, FL 34217', termEnd: '2027-08-01', prepayAmount: 600, declined: false, canDecline: true,
        },
      ],
    });
    render(<MyPlanTab customer={customer} />);
    expect(await screen.findByText('12 Palm Ave, Bradenton, FL 34202')).toBeInTheDocument();
    expect(screen.getByText('400 Gulf Dr, Unit 3, Holmes Beach, FL 34217')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Don’t renew my plan' })[1]);
    expect(screen.getByText('Don’t renew the plan at 400 Gulf Dr, Unit 3, Holmes Beach, FL 34217?')).toBeInTheDocument();
    expect(screen.queryByText('Don’t renew the plan at 12 Palm Ave, Bradenton, FL 34202?')).not.toBeInTheDocument();
  });

  it('keeps the property label on a declined card', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{
        id: 'term-1', propertyLabel: '12 Palm Ave, Bradenton, FL 34202', termEnd: '2027-05-20', prepayAmount: 450, declined: true, canDecline: false,
      }],
    });
    render(<MyPlanTab customer={customer} />);
    expect(await screen.findByText('12 Palm Ave, Bradenton, FL 34202')).toBeInTheDocument();
    expect(screen.getByText(/Your plan will not renew\. Coverage continues through May 20, 2027\./)).toBeInTheDocument();
  });

  it('with no property label, the confirm step asks "Don’t renew your plan?"', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{ id: 'term-1', propertyLabel: null, termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true }],
    });
    render(<MyPlanTab customer={customer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Don’t renew my plan' }));
    expect(screen.getByText('Don’t renew your plan?')).toBeInTheDocument();
  });

  it('hides the decline control once a conflicting decision (renew) is already on file', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: false }],
    });
    render(<MyPlanTab customer={customer} />);
    await screen.findByText('Termite Annual Plan');
    expect(screen.queryByRole('button', { name: 'Don’t renew my plan' })).not.toBeInTheDocument();
  });

  it('renders the declined state directly with no control to press again', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: true, canDecline: false }],
    });
    render(<MyPlanTab customer={customer} />);
    expect(await screen.findByText(/Your plan will not renew\. Coverage continues through May 20, 2027\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Don’t renew my plan' })).not.toBeInTheDocument();
  });

  it('requires a confirm step, then calls the decline endpoint with the term id and shows the confirmation copy', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true }],
    });
    api.declineTermiteAnnualPlanRenewal.mockResolvedValue({
      ok: true, termId: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, alreadyDeclined: false,
    });
    render(<MyPlanTab customer={customer} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Don’t renew my plan' }));
    // Confirm step shown; the decline endpoint is NOT called yet.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(api.declineTermiteAnnualPlanRenewal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.declineTermiteAnnualPlanRenewal).toHaveBeenCalledTimes(1));
    expect(api.declineTermiteAnnualPlanRenewal).toHaveBeenCalledWith('term-1');
    expect(await screen.findByText(/Your plan will not renew\. Coverage continues through May 20, 2027\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });

  it('"Never mind" backs out without calling the decline endpoint', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true }],
    });
    render(<MyPlanTab customer={customer} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Don’t renew my plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Never mind' }));

    expect(api.declineTermiteAnnualPlanRenewal).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Don’t renew my plan' })).toBeInTheDocument();
  });

  it('shows an error and leaves the confirm step open when the decline call fails', async () => {
    api.getTermiteAnnualPlan.mockResolvedValue({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true }],
    });
    api.declineTermiteAnnualPlanRenewal.mockRejectedValue(new Error('This plan’s renewal window has already passed.'));
    render(<MyPlanTab customer={customer} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Don’t renew my plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This plan’s renewal window has already passed.');
    // Never silently treated as declined — the confirm step (and its
    // Confirm button) is still open, not the terminal declined render.
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  // codex round-1 P1: a load FAILURE is a distinct, explicit state — never
  // silently hidden the way "gate off / no term" renders nothing.
  it('shows an error state with a Retry button when the load fails, never silently hiding the card', async () => {
    api.getTermiteAnnualPlan.mockRejectedValueOnce(new Error('network down'));
    render(<MyPlanTab customer={customer} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t be loaded/i);
    expect(screen.queryByRole('button', { name: 'Don’t renew my plan' })).not.toBeInTheDocument();

    api.getTermiteAnnualPlan.mockResolvedValueOnce({
      available: true,
      terms: [{ id: 'term-1', termEnd: '2027-05-20', prepayAmount: 450, declined: false, canDecline: true }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.getTermiteAnnualPlan).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Don’t renew my plan' })).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t be loaded/i)).not.toBeInTheDocument();
  });
});
