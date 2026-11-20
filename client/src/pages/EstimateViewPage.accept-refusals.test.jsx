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
  const ANSWER = 'refuseStaleQuoteRef.current(r.status, body)';
  // The shared answer: both codes, a 409 only, the server's words kept, the hold released.
  const answerSource = () => {
    const at = pageSource.indexOf('refuseStaleQuoteRef.current = (status, body) => {');
    return pageSource.slice(at, pageSource.indexOf('\n  };', at));
  };

  it('has one shared answer: both codes, the server\'s words in the banner, the hold released', () => {
    expect(pageSource).toContain("const STALE_QUOTE_CODES = new Set(['RESTART_STATE_CHANGED', 'PLAN_START_STATE_CHANGED']);");
    const answer = answerSource();
    expect(answer).toContain('if (status !== 409 || !STALE_QUOTE_CODES.has(body?.code)) return false;');
    expect(answer).toContain('setStaleQuoteNote(body.error');
    expect(answer).toContain("recoverFromDeadHold('configure');");
  });

  it('takes the shared answer in the accept handler, ahead of the slot split', () => {
    const slotSplit = pageSource.indexOf("const slotGone = body.code === 'SLOT_UNAVAILABLE'");
    const at = pageSource.lastIndexOf(`if (${ANSWER}) return;`, slotSplit);
    expect(at).toBeGreaterThan(-1);
    // The same handler: no other callback starts between the branch and the split.
    expect(pageSource.slice(at, slotSplit)).not.toContain('useCallback(');
  });

  it('takes the same answer from every card step (codex pre-push P1): no card is asked for on a refused quote', () => {
    // Each card-intent request is answered before anything else reads its body as a card to capture.
    const requests = [...pageSource.matchAll(/fetch\(`\$\{API_BASE\}\/public\/estimates\/\$\{token\}\/(card-hold-intent|recurring-card-intent)`/g)];
    expect(requests).toHaveLength(4);
    for (const request of requests) {
      const next = pageSource.slice(request.index, request.index + 900);
      expect([request[1], next.includes(ANSWER)]).toEqual([request[1], true]);
    }
    expect(pageSource.split(ANSWER).length - 1).toBe(6);
  });

  it('takes the same answer from the reserve, before its generic 409 copy (codex pre-push P1): no time is held on a refused quote', () => {
    const reserve = pageSource.indexOf('fetch(`${API_BASE}/public/estimates/${token}/reserve`, {');
    expect(reserve).toBeGreaterThan(-1);
    const generic = pageSource.indexOf("const message = body.error || 'Unable to reserve this slot.';", reserve);
    const answer = pageSource.indexOf(`if (${ANSWER}) return;`, reserve);
    expect(answer).toBeGreaterThan(reserve);
    expect(answer).toBeLessThan(generic);
  });

  it('a refused quote\'s /data load releases the hold it still offers, once per hold, and never adopts it (codex pre-push P1)', () => {
    expect(pageSource).toContain('const quoteRefusalCode = data?.estimate?.quoteRefusal?.code || null;');
    const eff = pageSource.slice(pageSource.indexOf('// A RELOADED page must start the clock immediately'), pageSource.indexOf('// ONE place that turns an extend outcome into page state'));
    const release = eff.indexOf('if (held && quoteRefusalCode) {');
    expect(release).toBeGreaterThan(-1);
    // Before the adoption, and it returns either way.
    expect(release).toBeLessThan(eff.indexOf('setReservation((prev) => {'));
    const branch = eff.slice(release, eff.indexOf('if (!held) {'));
    expect(branch).toContain("if (!inlineConfirmBusyRef.current && refusedQuoteHoldReleaseRef.current !== held.id) {");
    expect(branch).toContain('pendingRecoveryHoldRef.current = held.id;');
    expect(branch).toContain("recoverFromDeadHold('configure');");
    expect(branch.trimEnd().endsWith('return;\n    }')).toBe(true);
    expect(eff).toContain('ctaPhase, quoteRefusalCode, recoverFromDeadHold]');
  });

  it('hands the slot picker the same answer for its slot reads (codex pre-push P1)', () => {
    expect(pageSource).toContain('onRefusal={(status, body) => refuseStaleQuoteRef.current(status, body)}');
  });

  it('a hold extension carries the captured recurring card, so the route retires it on a refused quote (codex pre-push P0)', () => {
    const extend = pageSource.indexOf('/reserve/${encodeURIComponent(scheduledServiceId)}/extend`');
    const call = pageSource.slice(pageSource.lastIndexOf('const capturedSetupIntentId = recurringCardSetupIntentIdRef.current;', extend), extend + 400);
    expect(call).toContain('body: JSON.stringify({ recurringCardSetupIntentId: capturedSetupIntentId })');
    // A 503 (Stripe could not confirm) stays retryable, so the card is kept for the accept's own retirement.
    expect(pageSource.slice(extend)).toContain("if (r.status === 429 || r.status >= 500) return 'retryable';");
  });

  it('reads a refused quote on a hold extension as a no-booking answer: the settle releases the hold and reloads into the banner', () => {
    const extend = pageSource.indexOf('/reserve/${encodeURIComponent(scheduledServiceId)}/extend`');
    const ok = pageSource.indexOf('if (r.ok) {', extend);
    const line = pageSource.indexOf("if (STALE_QUOTE_CODES.has(body.code)) return 'no_booking';", extend);
    expect(line).toBeGreaterThan(ok);
    // In the extend helper itself: before its catch-all expiry answer.
    expect(line).toBeLessThan(pageSource.indexOf("return 'expired';", extend));
  });

  it('shows the banner from the first load when /data marks the quote (codex pre-push P1)', () => {
    expect(pageSource).toContain('const staleQuoteNote = staleQuoteReply || data?.estimate?.quoteRefusal?.error || null;');
  });

  it('locks booking and payment while its banner is up (codex pre-push P1)', () => {
    // The reserve, the confirm and the accept itself each refuse it, and list it as a dependency,
    // so a callback created before the refusal never runs on the stale value.
    for (const name of ['const handlePaymentChoice = useCallback(', 'const handleConfirm = useCallback(', 'const performAccept = useCallback(']) {
      const at = pageSource.indexOf(name);
      expect(at).toBeGreaterThan(-1);
      const depsAt = pageSource.indexOf('\n  }, [', at);
      expect(pageSource.slice(at, depsAt)).toContain('if (staleQuoteNote) return;');
      expect(pageSource.slice(depsAt, pageSource.indexOf(']);', depsAt))).toMatch(/\bstaleQuoteNote\b/);
    }
    // Both payment button groups turn off. The one booking condition turns off too, so the picker,
    // the pick-a-time prompts, the sticky booking bar and every "book" button go away: a frozen
    // picker still took keyboard input, and the bar still scrolled to it (codex pre-push P1 x2).
    expect(pageSource.match(/disabled=\{readOnlyPreview \|\| consumerNoticeBlocked \|\| !!staleQuoteNote \|\| /g)).toHaveLength(2);
    expect(pageSource).toContain("const canShowSlotPicker = acceptance.mode === 'standard_slot_pick' && !staleQuoteNote;");
    expect(pageSource.match(/const canShowSlotPicker = /g)).toHaveLength(1);
    expect(pageSource).toContain('canBook={canShowSlotPicker && cta.canAccept}');
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
