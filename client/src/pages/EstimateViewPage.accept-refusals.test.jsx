// @vitest-environment jsdom
/**
 * Approve refusals that are not about the time (estimate page audit
 * 2026-11-05). The page read every accept 409 it did not name as "That slot
 * was just taken", so a customer picked a new time into the same refusal (a
 * discount refresh, a re-price, a retired plan option, a frozen restart quote).
 * Driving the accept handler for real needs the whole /data payload, which a
 * unit suite cannot mount (EstimateViewPage.hold-countdown.test.jsx says the
 * same), so its routing is pinned by source; the banners render for real.
 */
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EstimateErrorBanner, SlotIssueBanner } from './EstimateViewPage';
// Vite's ?raw import: the page source as a string.
import pageSource from './EstimateViewPage.jsx?raw';

afterEach(cleanup);

// The accept handler's 409 branch, from its slot split to its own end.
const accept409 = () => {
  const at = pageSource.indexOf("const slotGone = body.code === 'SLOT_UNAVAILABLE'");
  return pageSource.slice(at, pageSource.indexOf('throw new Error(body.error || `accept failed: ${r.status}`);', at));
};

describe('accept 409s', () => {
  it('sends only a gone slot or a lapsed hold to the "slot taken" recovery', () => {
    const handler = accept409();
    const split = handler.indexOf('if (expired || slotGone) {');
    expect(split).toBeGreaterThan(-1);
    expect(handler.indexOf("recoverFromDeadHold(expired ? 'reservation_expired' : 'slot_conflict');")).toBeGreaterThan(split);
  });

  it('gives every other 409 the same recovery, with the server reason for the banner', () => {
    const handler = accept409();
    const split = handler.indexOf('if (expired || slotGone) {');
    const withReason = handler.indexOf("recoverFromDeadHold('slot_conflict', body.error || null);");
    expect(withReason).toBeGreaterThan(split);
    // No new exit: the reason rides the recovery, so a refusal that needs its
    // reload (a renewal with no appointment) still gets it.
    expect(handler.slice(split)).not.toContain('throw new Error');
  });
});

describe('a refused plan quote (RESTART_STATE_CHANGED / PLAN_START_STATE_CHANGED)', () => {
  // The customer's own plan quote no longer fits the account, or staff changed
  // it. The generic recovery offered "Refresh times" on that same dead quote
  // (codex pre-push P1 on the staff-toggle fix).
  const branchAt = () => pageSource.indexOf("if (body.code === 'RESTART_STATE_CHANGED' || body.code === 'PLAN_START_STATE_CHANGED') {");

  it('takes its own branch in the accept handler, ahead of the slot split', () => {
    const at = branchAt();
    expect(at).toBeGreaterThan(-1);
    const slotSplit = pageSource.indexOf("const slotGone = body.code === 'SLOT_UNAVAILABLE'");
    expect(at).toBeLessThan(slotSplit);
    // The same handler: no other callback starts between the branch and the split.
    expect(pageSource.slice(at, slotSplit)).not.toContain('useCallback(');
    const branch = pageSource.slice(at, pageSource.indexOf('return;', at));
    expect(branch).toContain('setStaleQuoteNote(body.error');
    expect(branch).toContain("recoverFromDeadHold('configure');");
  });

  it('keeps its banner above the slot banners, below only a stuck hold release', () => {
    // A stuck release keeps its retry first (codex r10 P2); once it clears,
    // the refused-quote banner stays in every phase.
    const at = pageSource.indexOf('const slotIssueBanner = recoveryStuck ? (');
    expect(at).toBeGreaterThan(-1);
    const chain = pageSource.slice(at, pageSource.indexOf(') : null;', at));
    const stale = chain.indexOf(') : staleQuoteNote ? (');
    expect(stale).toBeGreaterThan(-1);
    expect(chain.indexOf('<SlotIssueBanner kind="stale_quote" note={staleQuoteNote} />')).toBeGreaterThan(stale);
    expect(chain.indexOf(") : ctaPhase === 'slot_conflict' || ctaPhase === 'reservation_expired' ? (")).toBeGreaterThan(stale);
  });
});

describe('the reserve refusal for a taken slot', () => {
  it('clears any reason an earlier accept refusal left, so it says "slot taken"', () => {
    const at = pageSource.indexOf('if (/slot no longer available/i.test(message)) {');
    expect(at).toBeGreaterThan(-1);
    const branch = pageSource.slice(at, pageSource.indexOf("setCtaPhase('slot_conflict');", at));
    expect(branch).toContain('setDeadHoldNote(null);');
  });

  it('is the only place outside the recovery that sets the slot_conflict phase', () => {
    expect(pageSource.match(/setCtaPhase\('slot_conflict'\)/g)).toHaveLength(1);
  });
});

describe('SlotIssueBanner', () => {
  it('shows the server reason in place of "slot taken"', () => {
    render(<SlotIssueBanner kind="conflict" note="That visit is before your move-in date. Please pick a time on or after it." />);
    expect(screen.getByText('That visit is before your move-in date. Please pick a time on or after it.')).toBeInTheDocument();
    expect(screen.queryByText(/That slot was just taken/)).not.toBeInTheDocument();
  });

  it('keeps the taken-slot copy when there is no reason', () => {
    render(<SlotIssueBanner kind="conflict" />);
    expect(screen.getByText(/That slot was just taken/)).toBeInTheDocument();
  });

  it('sends a refused plan quote back to the portal and never offers "Refresh times"', () => {
    const reason = 'This estimate changed since it was created — please go back to your portal for a current price.';
    render(<SlotIssueBanner kind="stale_quote" note={reason} onRetry={() => {}} />);
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to your Waves portal' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Refresh times' })).not.toBeInTheDocument();
    expect(screen.queryByText(/That slot was just taken/)).not.toBeInTheDocument();
  });
});

describe('EstimateErrorBanner', () => {
  it('prints a server sentence with one period, not two', () => {
    const { container } = render(<EstimateErrorBanner error="This estimate is being re-priced — please try again in a few minutes." />);
    expect(container.textContent).toContain('Something went wrong: This estimate is being re-priced — please try again in a few minutes. Try again or call');
    expect(container.textContent).not.toContain('minutes..');
  });
});

describe('the included-item removal message', () => {
  it('gives the main Waves number', () => {
    expect(pageSource).not.toContain('234-8929');
    expect(pageSource).toContain("Give us a call at ${WAVES_PHONE_DISPLAY} and we'll sort it out with you.");
  });
});
