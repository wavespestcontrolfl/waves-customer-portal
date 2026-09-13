// @vitest-environment jsdom
// PropertyTab autosave — server-rejected fields (prod incident 2026-09-11):
// a customer typing a half-finished HOA email alongside valid fields had
// EVERY field in the batch rejected and re-queued forever, because the old
// client treated any failed PUT as a generic retryable error and merged the
// whole failed batch back into the pending queue — including the
// permanently-invalid field. One bad field then poisoned every later
// autosave of every OTHER field, silently, behind a single unhelpful "error"
// banner.
//
// Contract under test:
//   - a field the server names as rejected is dropped from the pending
//     queue (never re-queued) and its message renders on the input, so a
//     LATER edit to a DIFFERENT field saves cleanly and does not carry the
//     dead field along;
//   - a genuine transport/5xx failure (no per-field detail from the server)
//     still re-queues the whole batch untouched, unchanged from before.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyPreferences: vi.fn(),
    getWateringPlan: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import { PropertyTab } from './PortalPage';

const customer = {
  id: 'cust-1', firstName: 'Pat', lastName: 'Customer',
  phone: '9415551234', email: 'pat@example.com', tier: null,
  property: {},
};

// Forces the debounced queue to flush immediately (bypasses the 1s timer,
// same mechanism the shell uses before a property switch) and waits for
// THIS flush to fully settle — including any re-queue/field-error handling
// in its catch block — before the caller proceeds. Using the real
// `waves:property-switching` waiters contract avoids racing the assertions
// against an in-flight promise the way polling on call counts alone would.
async function flushNow() {
  const waiters = [];
  await act(async () => {
    fireEvent(window, new CustomEvent('waves:property-switching', { detail: { waiters } }));
    await Promise.allSettled(waiters);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  api.getWateringPlan.mockResolvedValue({ available: false });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PropertyTab — server-rejected field never poisons the pending queue', () => {
  it('drops the rejected field, surfaces its message, and a later save of a DIFFERENT field excludes it', async () => {
    api.updatePropertyPreferences.mockImplementation(async (payload) => {
      if ('hoaEmail' in payload) {
        const err = new Error('"hoaEmail" must be a valid email');
        err.status = 400;
        err.rejected = [{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }];
        throw err;
      }
      return { preferences: {} };
    });

    render(<PropertyTab customer={customer} />);
    const hoaEmailInput = await screen.findByLabelText('Contact Email');
    fireEvent.change(hoaEmailInput, { target: { value: 'not-an-email' } });

    await flushNow();

    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
    expect(api.updatePropertyPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ hoaEmail: 'not-an-email' }),
    );
    // Surfaced on the offending field, not just a generic banner.
    expect(await screen.findByText('"hoaEmail" must be a valid email')).toBeInTheDocument();
    // The optimistic value stays visible — the fix does not revert typing.
    expect(hoaEmailInput).toHaveValue('not-an-email');

    // A later edit to a DIFFERENT field must save on its own, WITHOUT the
    // rejected hoaEmail riding along — that is the poisoned-queue regression.
    const sideGateInput = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(sideGateInput, { target: { value: 'Lift latch, no code' } });

    await flushNow();

    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2);
    const secondPayload = api.updatePropertyPreferences.mock.calls[1][0];
    expect(secondPayload.sideGateAccess).toBe('Lift latch, no code');
    expect(secondPayload).not.toHaveProperty('hoaEmail');
  });

  it('a 200 response naming a rejected field in a mixed batch also drops it from later saves', async () => {
    // Mirrors the server's new partial-success contract: 200 with a
    // `rejected` list rather than a thrown error, for a batch that mixed
    // valid and invalid fields.
    api.updatePropertyPreferences.mockResolvedValueOnce({
      preferences: { parkingNotes: 'Leave by garage' },
      saved: true,
      rejected: [{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }],
    });
    api.updatePropertyPreferences.mockResolvedValueOnce({ preferences: {} });

    render(<PropertyTab customer={customer} />);
    const hoaEmailInput = await screen.findByLabelText('Contact Email');
    const parkingInput = await screen.findByPlaceholderText(/Park in driveway/);
    fireEvent.change(parkingInput, { target: { value: 'Leave by garage' } });
    fireEvent.change(hoaEmailInput, { target: { value: 'not-an-email' } });

    await flushNow();

    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('"hoaEmail" must be a valid email')).toBeInTheDocument();

    const sideGateInput = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(sideGateInput, { target: { value: 'Gate code 1234' } });

    await flushNow();

    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2);
    const secondPayload = api.updatePropertyPreferences.mock.calls[1][0];
    expect(secondPayload.sideGateAccess).toBe('Gate code 1234');
    expect(secondPayload).not.toHaveProperty('hoaEmail');
  });
});

describe('PropertyTab — genuine transport/5xx failures still re-queue the whole batch', () => {
  it('retries the same fields (no per-field detail on the error)', async () => {
    let callCount = 0;
    api.updatePropertyPreferences.mockImplementation(async (payload) => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error('Server error');
        err.status = 500;
        throw err;
      }
      return { preferences: {} };
    });

    render(<PropertyTab customer={customer} />);
    const sideGateInput = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(sideGateInput, { target: { value: 'first attempt' } });

    await flushNow();
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);

    // No new edit — the retry must come from the re-queued pending value.
    await flushNow();
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2);
    expect(api.updatePropertyPreferences).toHaveBeenLastCalledWith(
      expect.objectContaining({ sideGateAccess: 'first attempt' }),
    );
  });
});

// The banner copy must describe THIS flush's failure (pre-push audit P1):
// a per-field message from an earlier batch stays on screen until the
// customer re-types that field, so keying the banner off the cumulative
// field-error map told a customer whose connection had just dropped to
// "see below" — pointing at a message about a different field.
describe('PropertyTab — the save banner describes the CURRENT failure', () => {
  it('reports a connection problem for a transport failure that follows an earlier field rejection', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.updatePropertyPreferences.mockImplementation(async (payload) => {
      if ('hoaEmail' in payload) {
        return {
          preferences: {},
          saved: true,
          rejected: [{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }],
        };
      }
      const err = new Error('Failed to fetch');
      throw err;
    });

    render(<PropertyTab customer={customer} />);
    const hoaEmailInput = await screen.findByLabelText('Contact Email');
    fireEvent.change(hoaEmailInput, { target: { value: 'not-an-email' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

    expect(screen.getByText(/Some details couldn't be saved:/)).toBeInTheDocument();
    // Named in the banner AND on the input it belongs to.
    expect(screen.getAllByText('"hoaEmail" must be a valid email').length).toBeGreaterThan(1);

    // Now a DIFFERENT field fails for a transport reason. The hoaEmail
    // message is still on screen (correctly — she hasn't re-typed it), but
    // the banner must talk about the connection, not point at it.
    const sideGateInput = await screen.findByLabelText('Side Gate / Backyard Access');
    fireEvent.change(sideGateInput, { target: { value: 'Lift latch' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });

    expect(screen.getByText('Could not save. Please check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText(/Some details couldn't be saved:/)).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});

// An all-invalid batch must leave NOTHING queued (codex r1 P1): the flush
// synthesizes a `confirmed_as_of` freshness stamp into every payload, and
// re-queuing that alongside the dropped fields left a metadata-only request
// the server 400s with no `rejected` list — which re-queues it again, so
// every later property-switch flush kept failing and blocked the switch.
describe('PropertyTab — a fully rejected batch queues nothing', () => {
  it('does not retry a metadata-only payload on the next flush', async () => {
    api.updatePropertyPreferences.mockImplementation(async () => {
      const err = new Error('"hoaEmail" must be a valid email');
      err.status = 400;
      err.rejected = [{ field: 'hoaEmail', message: '"hoaEmail" must be a valid email' }];
      throw err;
    });

    render(<PropertyTab customer={customer} />);
    const hoaEmailInput = await screen.findByLabelText('Contact Email');
    fireEvent.change(hoaEmailInput, { target: { value: 'nope' } });

    await flushNow();
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
    expect(api.updatePropertyPreferences.mock.calls[0][0]).toHaveProperty('confirmed_as_of');

    // No new edit: there must be nothing left to send.
    await flushNow();
    await flushNow();
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
  });
});
