// @vitest-environment jsdom
/**
 * Customer 360 — "Cancel plan…" dialog (cancel-flow C3).
 *
 * The server owns every fact; the dialog collects the choices, shows the
 * before/after it was given, and commits ONCE. Pinned here:
 *   - preview facts render from the server payload (no client math)
 *   - scope / effective-date choices re-preview; the annual-prepay refund
 *     line is the server's number and says "not refunded automatically"
 *   - the commit body carries every choice (scope, effective date, prepay
 *     disposition, waive, send-confirmation, reason, note)
 *   - an unattributable scoped selection disables the commit
 *   - the outcome view is truthful (partial run, channels actually accepted)
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CancelPlanDialog from './CancelPlanDialog';

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

const CUSTOMER = { id: 'customer-a', firstName: 'Avery', lastName: 'Customer' };

function previewBody(overrides = {}) {
  return {
    enabled: true,
    customer: { id: 'customer-a', name: 'Avery Customer', waveguardTier: 'Silver' },
    eligible: true,
    wholeAccount: true,
    scope: [],
    scopeLabels: [],
    scopedSupported: null,
    scopeError: null,
    impact: {
      families: [
        { key: 'pest_control', label: 'Pest Control', monthlyRate: 45, upcomingVisits: 2, nextVisitDate: '2099-01-05' },
        { key: 'lawn_care', label: 'Lawn Care', monthlyRate: 60, upcomingVisits: 1, nextVisitDate: '2099-01-09' },
      ],
      tierBefore: 'Silver', tierAfter: null, accountMonthlyBefore: 105, accountMonthlyAfter: 0, remaining: [],
      visitsCancelled: 3, nextVisitCancelled: '2099-01-05', openBalance: 12.5, autopayOn: true, termiteRental: false,
    },
    effectiveDate: 'now',
    effectiveOn: '2026-08-31',
    prepay: null,
    waiveLateFee: false,
    sendConfirmation: true,
    confirmationChannels: { sms: true, email: true },
    reasonCode: null,
    reasonCodes: ['price', 'other'],
    note: '',
    previewFingerprint: 'fp-approved-1',
    ...overrides,
  };
}

let calls;
function stubFetch(handler) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn((url, options = {}) => {
    const path = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body });
    return handler(path, body);
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('waves_admin_token', 'test-token');
});

describe('CancelPlanDialog', () => {
  it('renders the server preview facts and commits the whole account with every choice in the body', async () => {
    stubFetch((path, body) => {
      if (path.endsWith('/cancel-plan/preview')) return response(previewBody({ note: body.note, reasonCode: body.reasonCode }));
      if (path.endsWith('/cancel-plan')) {
        return response({
          success: true, requestId: 'req-1', processed: true, visitsPulled: 3, scope: [], remaining: [], tierBefore: 'Silver', tierAfter: null,
          effectiveDate: '2026-08-31', lateFeeWaived: true, confirmationRequested: true, confirmationChannels: ['sms', 'email'], errors: [],
        });
      }
      return response({});
    });
    const onDone = vi.fn().mockResolvedValue(null);
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={onDone} />);

    await screen.findByText('the whole plan');
    expect(screen.getByText(/3 \(next Jan 5, 2099\)/)).toBeInTheDocument();
    expect(screen.getByText('Silver → none')).toBeInTheDocument();
    expect(screen.getByText('$105.00 → $0.00')).toBeInTheDocument();
    expect(screen.getByText('$12.50 (still payable)')).toBeInTheDocument();
    expect(screen.getByText('text + email')).toBeInTheDocument();
    expect(calls[0].body).toEqual(expect.objectContaining({ families: [], effectiveDate: 'now', sendConfirmation: true, waiveLateFee: false }));

    fireEvent.click(screen.getByLabelText('Waive the scheduled-visit fee on pulled visits'));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'price' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Called in' } });

    const commit = screen.getByRole('button', { name: 'Cancel the whole plan' });
    expect(commit).toBeEnabled();
    fireEvent.click(commit);

    await screen.findByText('Done.');
    const commitCall = calls.find((c) => c.path.endsWith('/cancel-plan') && !c.path.includes('preview'));
    expect(commitCall.body).toEqual({
      families: [], effectiveDate: 'now', prepayDisposition: null, waiveLateFee: true, sendConfirmation: true, reasonCode: 'price', note: 'Called in',
      // The approved facts ride into the commit — the server refuses
      // (preview_changed) if the live numbers moved.
      previewFingerprint: 'fp-approved-1',
    });
    expect(screen.getByText('sms + email')).toBeInTheDocument();
    expect(screen.getByText('waived')).toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /^Cancel the whole plan/ })).not.toBeInTheDocument();
  });

  it('a processed run with follow-up errors is "Partially done", never "Done."', async () => {
    stubFetch((path) => {
      if (path.endsWith('/cancel-plan/preview')) return response(previewBody({}));
      if (path.endsWith('/cancel-plan')) {
        // The server intentionally leaves processed=true when a follow-up
        // step (case write, prepay decision, refund task) failed — that run
        // still needs the office.
        return response({
          success: true, requestId: 'req-e', processed: true, visitsPulled: 1, scope: [], remaining: [], tierBefore: 'Silver', tierAfter: null,
          effectiveDate: '2026-08-31', lateFeeWaived: false, confirmationRequested: false, confirmationChannels: [], errors: ['refund_task_failed'],
        });
      }
      return response({});
    });
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn().mockResolvedValue(null)} />);
    await screen.findByText('the whole plan');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the whole plan' }));
    await screen.findByText('Partially done — the office review alert has the details.');
    expect(screen.queryByText('Done.')).not.toBeInTheDocument();
    expect(screen.getByText(/Needs review: refund_task_failed/)).toBeInTheDocument();
  });

  it('shows only the confirmation channels that can actually send', async () => {
    stubFetch((path) => {
      if (path.endsWith('/cancel-plan/preview')) {
        return response(previewBody({ confirmationChannels: { sms: false, email: true } }));
      }
      return response({});
    });
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('the whole plan');
    // Never promise "text + email" when there is no phone on file.
    expect(screen.queryByText('text + email')).not.toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
  });

  it('scoped selection re-previews with the families and an unattributable scope disables the commit', async () => {
    stubFetch((path, body) => {
      if (path.endsWith('/cancel-plan/preview')) {
        if (body.families.length === 0) return response(previewBody());
        if (body.families.includes('lawn_care')) {
          return response(previewBody({ wholeAccount: false, scope: ['lawn_care'], scopeLabels: ['Lawn Care'], scopedSupported: false, scopeError: 'scoped_unattributed' }));
        }
        return response(previewBody({ wholeAccount: false, scope: body.families, scopeLabels: ['Pest Control'], scopedSupported: true }));
      }
      return response({});
    });
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('the whole plan');

    fireEvent.click(screen.getByLabelText('Only these services'));
    // Nothing ticked yet → cannot commit.
    expect(screen.getByRole('button', { name: /^Cancel the selected services/ })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/^Lawn Care/));
    await screen.findByText(/cannot be priced from the plan-rate ledger/);
    expect(calls.at(-1).body.families).toEqual(['lawn_care']);
    expect(screen.getByRole('button', { name: /^Cancel Lawn Care/ })).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/^Lawn Care/));
    fireEvent.click(screen.getByLabelText(/^Pest Control/));
    await waitFor(() => expect(calls.at(-1).body.families).toEqual(['pest_control']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel Pest Control' })).toBeEnabled());
  });

  it('checking EVERY service in scoped mode never commits a whole-account cancel from the scoped button', async () => {
    stubFetch((path, body) => {
      if (path.endsWith('/cancel-plan/preview')) {
        if (body.families.length === 0) return response(previewBody());
        if (body.families.length === 2) {
          // The server canonicalizes an all-families selection to whole-account.
          return response(previewBody({ wholeAccount: true, scope: [], scopeLabels: [], scopedSupported: null }));
        }
        return response(previewBody({ wholeAccount: false, scope: body.families, scopeLabels: ['Pest Control'], scopedSupported: true }));
      }
      return response({});
    });
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('the whole plan');

    fireEvent.click(screen.getByLabelText('Only these services'));
    // Nothing ticked yet: an EMPTY scope also previews as the whole account,
    // but the operator has not selected "every service" — no warning, just
    // a disabled button (ui-verify 2026-09-02).
    await screen.findByLabelText(/^Pest Control/);
    expect(screen.queryByText(/switch to "The whole plan"/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel/ })).toBeDisabled();
    // ...and the whole-account numbers do not masquerade as the selection's.
    await screen.findByText(/Tick at least one service/);
    expect(screen.queryByText('Silver → none')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/^Pest Control/));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel Pest Control' })).toBeEnabled());

    fireEvent.click(screen.getByLabelText(/^Lawn Care/));
    await screen.findByText(/switch to "The whole plan"/);
    // The commit stays disabled: a whole-account sweep (which can pull visits
    // with no checkbox) must be approved from whole-plan mode.
    expect(screen.getByRole('button', { name: /^Cancel/ })).toBeDisabled();
  });

  it('a failed preview refresh disables the commit even though the prior preview stays rendered', async () => {
    let failNext = false;
    const prepay = {
      termId: 'term-1', planLabel: 'Annual Pest', termStart: '2026-03-01', termEnd: '2027-02-28',
      prepaidAmount: 480, includedVisits: 4, disposition: 'end_now_refund',
      refund: { prepaidAmount: 480, includedVisits: 4, completedVisits: 1, remainingVisits: 3, amount: 360, needsManualCalc: false },
    };
    stubFetch((path) => {
      if (path.endsWith('/cancel-plan/preview')) {
        if (failNext) return response({ error: 'boom' }, 500);
        return response(previewBody({ prepay }));
      }
      return response({});
    });
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('the whole plan');
    expect(screen.getByRole('button', { name: 'Cancel the whole plan' })).toBeEnabled();

    // The operator changes the facts; the refresh FAILS. The old facts stay
    // on screen, but the red button must not commit choices it never showed.
    failNext = true;
    fireEvent.click(screen.getByLabelText(/^End of paid coverage/));
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^Cancel/ })).toBeDisabled();
  });

  it('annual prepay: effective-date choice drives the disposition; the refund line is the server number and is never automatic', async () => {
    const prepay = (disposition) => ({
      termId: 'term-1', planLabel: 'Annual Pest', termStart: '2026-03-01', termEnd: '2027-02-28', prepaidAmount: 480, includedVisits: 4,
      disposition,
      refund: disposition === 'end_now_refund' ? { prepaidAmount: 480, includedVisits: 4, completedVisits: 1, remainingVisits: 3, amount: 360, needsManualCalc: false } : null,
    });
    stubFetch((path, body) => {
      if (path.endsWith('/cancel-plan/preview')) {
        const end = body.effectiveDate === 'end_of_coverage';
        return response(previewBody({ effectiveDate: body.effectiveDate, effectiveOn: end ? '2027-02-28' : '2026-08-31', prepay: prepay(end ? 'end_at_term' : 'end_now_refund') }));
      }
      if (path.endsWith('/cancel-plan')) {
        return response({ success: true, processed: true, visitsPulled: 0, scope: [], effectiveDate: '2027-02-28', keptThrough: '2027-02-28', confirmationRequested: false, confirmationChannels: [], errors: [] });
      }
      return response({});
    });
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText(/\$360\.00 = \$480\.00 ÷ 4 visits × 3 remaining/);
    expect(screen.getByText(/not refunded automatically/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/^End of paid coverage/));
    await waitFor(() => expect(calls.at(-1).body.effectiveDate).toBe('end_of_coverage'));
    await screen.findByText('Feb 28, 2027');
    expect(screen.queryByText(/not refunded automatically/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Send the customer the confirmation text and email'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the whole plan' }));
    await screen.findByText('Done.');
    const commitCall = calls.find((c) => /\/cancel-plan$/.test(c.path));
    expect(commitCall.body).toEqual(expect.objectContaining({ effectiveDate: 'end_of_coverage', prepayDisposition: 'end_at_term', sendConfirmation: false }));
    expect(screen.getByText('nothing (by choice)')).toBeInTheDocument();
  });

  it('a partial run and a nothing-to-cancel account are reported truthfully', async () => {
    stubFetch((path) => {
      if (path.endsWith('/cancel-plan/preview')) return response(previewBody());
      if (path.endsWith('/cancel-plan')) {
        return response({ success: true, processed: false, visitsPulled: 1, scope: [], effectiveDate: '2026-08-31', confirmationRequested: true, confirmationChannels: ['email'], errors: ['in_progress_visit:s9'] });
      }
      return response({});
    });
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('the whole plan');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the whole plan' }));
    await screen.findByText(/Partially done/);
    expect(screen.getByText(/Needs review: in_progress_visit:s9/)).toBeInTheDocument();
    expect(screen.getByText('email')).toBeInTheDocument();
    cleanup();

    stubFetch((path) => (path.endsWith('/cancel-plan/preview') ? response(previewBody({ eligible: false })) : response({})));
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText(/no active plan, recurring service, or upcoming visit/);
    expect(screen.getByRole('button', { name: 'Cancel the whole plan' })).toBeDisabled();
  });

  it('a repair retry previews as committable with the retry notice', async () => {
    stubFetch((path) => (path.endsWith('/cancel-plan/preview')
      ? response(previewBody({ eligible: true, repairRetry: true }))
      : response({})));
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText(/A prior cancellation attempt left follow-up steps unfinished/);
    expect(screen.getByRole('button', { name: 'Cancel the whole plan' })).not.toBeDisabled();
  });

  it('an orphaned scoped repair surfaces with a Retry action — the durable scope is reachable even with its family gone from live rows', async () => {
    stubFetch((path, body) => (path.endsWith('/cancel-plan/preview')
      ? response(previewBody({
        openScopedRepairs: [{ families: ['lawn_care'], labels: ['Lawn Care'] }],
        ...(body && body.families && body.families.length ? { repairRetry: true } : {}),
      }))
      : response({})));
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText(/An unfinished cancellation of Lawn Care still has follow-up steps open/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry it' }));
    // The retry drives a scoped preview for the durable acceptance scope.
    await waitFor(() => {
      const last = calls.filter((c) => c.path.endsWith('/cancel-plan/preview')).pop();
      expect(last.body.families).toEqual(['lawn_care']);
    });
  });

  it('a repair retry syncs the ACCEPTED choices into the controls — the dialog never shows an unchecked waiver over a run that waives', async () => {
    stubFetch((path) => (path.endsWith('/cancel-plan/preview')
      ? response(previewBody({ eligible: true, repairRetry: true, waiveLateFee: true, sendConfirmation: false }))
      : response({})));
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText(/A prior cancellation attempt left follow-up steps unfinished/);
    await waitFor(() => {
      expect(screen.getByLabelText('Waive the scheduled-visit fee on pulled visits')).toBeChecked();
      expect(screen.getByLabelText('Send the customer the confirmation text and email')).not.toBeChecked();
    });
    // The DRIFT direction locks: the server would restore these on commit,
    // so an editable control here would make the screen lie about the run.
    expect(screen.getByLabelText('Waive the scheduled-visit fee on pulled visits')).toBeDisabled();
    expect(screen.getByLabelText('Send the customer the confirmation text and email')).toBeDisabled();
  });

  it('scheduled-visit fee exposure renders from the server preview and clears when waived', async () => {
    stubFetch((path) => (path.endsWith('/cancel-plan/preview')
      ? response(previewBody({
        visitFees: {
          applies: true, unresolved: false, total: 35,
          visits: [{ id: 'v1', lane: 'card_hold', feeApplies: true, feeAmount: 35, unresolved: false }],
        },
      }))
      : response({})));
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText(/\$35\.00 in scheduled-visit fees will be charged on 1 pulled visit unless waived\./);
    fireEvent.click(screen.getByLabelText('Waive the scheduled-visit fee on pulled visits'));
    expect(screen.queryByText(/in scheduled-visit fees will be charged/)).not.toBeInTheDocument();
    cleanup();

    // Unverifiable lane: fee-may-apply, never a silent no-fee.
    stubFetch((path) => (path.endsWith('/cancel-plan/preview')
      ? response(previewBody({
        visitFees: { applies: true, unresolved: true, total: null, visits: [{ id: 'v1', lane: null, feeApplies: true, feeAmount: null, unresolved: true }] },
      }))
      : response({})));
    render(<CancelPlanDialog customer={CUSTOMER} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText(/A scheduled-visit fee may apply to 1 pulled visit — the amount could not be verified/);
  });
});
