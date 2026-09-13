// @vitest-environment jsdom
// HoldCountdownBar / ReviewPhase hold timer (owner case 2026-09-11).
//
// A customer reloaded the estimate page mid-checkout, which re-offered her own
// uncommitted hold as an "existing appointment" — a mode that rendered NO
// countdown at all and carried no expiry — spent the 15-minute hold on card
// entry, and confirmed 34 seconds late. The accept 409'd with copy that read
// as "that slot was taken", so she believed she had signed up and paid.
//
// Pins here: the bar renders for an adopted hold, escalates, extends, honours
// the server's 60-minute ceiling, and never renders for a genuinely committed
// appointment.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewPhase, ExistingAppointmentCard } from './EstimateViewPage';
// Vite's ?raw import: the source as a string, no fs/__dirname (which vitest's
// http-served module URLs can't resolve).
import pageSource from './EstimateViewPage.jsx?raw';

// Slices used by the source pins. The hold logic lives in three named
// pieces — extendHold (transport), settleExtendOutcome (what an outcome
// means), extendHoldAndSettle (tracking + the acceptance boundary) — so the
// pins name the piece they are about instead of guessing at offsets.
const sliceBetween = (from, to) => pageSource.slice(pageSource.indexOf(from), pageSource.indexOf(to));
const SETTLE = sliceBetween('const settleExtendOutcome = useCallback', '  const extendHoldAndSettle = useCallback');
const WRAPPER = sliceBetween('const extendHoldAndSettle = useCallback', '}, [extendHold, settleExtendOutcome]);');

afterEach(() => cleanup());

const reviewProps = (overrides = {}) => ({
  slotId: '2026-09-16_13-00_tech-1',
  slotMeta: { date: '2026-09-16', time: '1:00 PM – 3:00 PM' },
  paymentPreference: 'prepay_annual',
  secondsRemaining: 600,
  onConfirm: () => {},
  onCancel: () => {},
  serviceMode: 'recurring',
  ...overrides,
});

describe('hold countdown bar', () => {
  it('renders the held time for a fresh slot pick', () => {
    render(<ReviewPhase {...reviewProps({ holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 754 })} />);
    expect(screen.getByText('Your time is held for 12:34')).toBeInTheDocument();
  });

  it('renders for an ADOPTED hold — the reload case that previously showed no timer at all', () => {
    render(<ReviewPhase {...reviewProps({
      existingAppointment: { id: 'hold-1', scheduledDate: '2026-09-16', windowDisplay: '1:00 PM – 3:00 PM', isHold: true },
      holdExpiresAt: '2026-09-11T19:00:00.000Z',
      secondsRemaining: 300,
    })} />);
    expect(screen.getByText('Your time is held for 5:00')).toBeInTheDocument();
  });

  it('renders NO bar for a genuinely committed appointment (no hold expiry)', () => {
    render(<ReviewPhase {...reviewProps({
      existingAppointment: { id: 'appt-1', scheduledDate: '2026-09-16', windowDisplay: '1:00 PM – 3:00 PM', isHold: false },
      holdExpiresAt: null,
    })} />);
    expect(screen.queryByText(/Your time is held for/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /keep my time/i })).not.toBeInTheDocument();
  });

  it('offers "Keep my time" only under 3:00, and calls the extend handler', async () => {
    const onExtendHold = vi.fn(() => Promise.resolve('ok'));
    const { rerender } = render(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 240, onExtendHold,
    })} />);
    expect(screen.queryByRole('button', { name: /keep my time/i })).not.toBeInTheDocument();

    rerender(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 150, onExtendHold,
    })} />);
    const button = screen.getByRole('button', { name: /keep my time/i });
    fireEvent.click(button);
    await waitFor(() => expect(onExtendHold).toHaveBeenCalledTimes(1));
  });

  it('hides the button and shows the ceiling copy once the server refuses another extension', () => {
    render(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 90,
      holdLimitReached: true, onExtendHold: vi.fn(),
    })} />);
    expect(screen.getByText(/can't be held any longer/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /keep my time/i })).not.toBeInTheDocument();
  });

  it('shows the checking copy while the 0:00 rescue extend is in flight', () => {
    render(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 0,
      holdChecking: true, onExtendHold: vi.fn(),
    })} />);
    expect(screen.getByText('Checking your time…')).toBeInTheDocument();
    // Reaching 0:00 is no longer terminal — the customer must not be told to
    // re-pick while the rescue attempt is still running.
    expect(screen.queryByText(/pick a time again/i)).not.toBeInTheDocument();
  });

  it('keeps the per-second countdown OUT of a live region — only the threshold node speaks (hold-grace self-audit)', () => {
    const { container } = render(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 300, onExtendHold: vi.fn(),
    })} />);
    const bar = screen.getByText(/Your time is held for/).closest('div');
    // A role="status" wrapper is an implicit polite live region: assistive
    // tech would re-announce the whole bar every single second.
    expect(bar).not.toHaveAttribute('role', 'status');
    expect(container.querySelectorAll('[aria-live]')).toHaveLength(1);
  });

  it('announces the 3:00 and 1:00 thresholds once each, not every tick', () => {
    const props = { holdExpiresAt: '2026-09-11T19:00:00.000Z', onExtendHold: vi.fn() };
    const { container, rerender } = render(<ReviewPhase {...reviewProps({ ...props, secondsRemaining: 240 })} />);
    const live = () => container.querySelector('[aria-live="polite"]').textContent;
    expect(live()).toBe('');
    rerender(<ReviewPhase {...reviewProps({ ...props, secondsRemaining: 180 })} />);
    expect(live()).toMatch(/three minutes/i);
    rerender(<ReviewPhase {...reviewProps({ ...props, secondsRemaining: 120 })} />);
    expect(live()).toMatch(/three minutes/i);
    rerender(<ReviewPhase {...reviewProps({ ...props, secondsRemaining: 45 })} />);
    expect(live()).toMatch(/less than one minute/i);
  });

  // The 0:00 rescue continuation lives inside EstimateViewPageInner, which a
  // unit render can't drive without the whole /data payload — so the guard is
  // pinned at the source, the way the server suites pin route wiring.
  it('discards a late 0:00 rescue verdict once the accept has committed (hold-grace self-audit)', () => {
    const src = pageSource;
    const rescue = src.slice(src.indexOf('const rescuedHoldId'), src.indexOf('const rescuedHoldId') + 1400);
    expect(rescue).toContain("const rescuedHoldId = reservationRef.current?.scheduledServiceId || null;");
    expect(rescue).toContain('return settleExtendOutcome(outcome, rescuedHoldId);');
    // An accept that committed (or is in flight) while the rescue was
    // running must NOT be overwritten with "your hold expired" — that would
    // tell a booked, charged customer that nothing happened.
    // The guard itself is in the shared settle, keyed on the hold the caller
    // started with.
    expect(SETTLE).toMatch(/\['submitting', 'success', 'slot_conflict', 'reservation_expired'\]\.includes\(ctaPhaseRef\.current\)/);
    expect(SETTLE).toMatch(/\(reservationRef\.current\?\.scheduledServiceId \|\| null\) !== holdIdAtStart/);
    expect(SETTLE.indexOf('if (stale) return outcome;')).toBeLessThan(SETTLE.indexOf('recoverFromDeadHold('));
  });
  // Round-2 findings. Both live inside EstimateViewPageInner, so they are
  // pinned at the source like the rescue guard above.
  it('treats a transport/5xx extend failure as retryable, never as an expiry (codex r2 P2)', () => {
    const src = pageSource;
    const fn = src.slice(src.indexOf('const extendHold = useCallback'), src.indexOf('const settleExtendOutcome'));
    // No verdict from the server ⇒ the hold may still be good and the commit
    // grace still accepts a confirm. Mapping this to 'expired' threw the
    // customer back to the slot picker during a blip — the very loss this
    // branch exists to prevent.
    expect(fn).toContain("if (r.status === 429 || r.status >= 500) return 'retryable';");
    expect(fn).toMatch(/catch\s*\{[^}]*return 'retryable';/);
    // 404 / terminal estimate state stays an authoritative expiry.
    expect(fn).toContain("return 'expired';");

    // Non-definitive outcomes come back untouched from the shared settle, so
    // the customer stays on the review card.
    expect(SETTLE).toContain("if (outcome !== 'slot_unavailable' && outcome !== 'expired' && outcome !== 'no_booking') return outcome;");
  });

  it('consumes a definitive slot_unavailable from every extend trigger (codex r2 P1)', () => {
    const src = pageSource;
    const wrapper = SETTLE;
    // slot_unavailable means the server DELETED the hold (a committed visit
    // took the window). Discarding it left the page claiming the time was
    // still held while the customer entered a card.
    expect(wrapper).toContain("if (outcome !== 'slot_unavailable' && outcome !== 'expired' && outcome !== 'no_booking') return outcome;");
    expect(wrapper).toContain("recoverFromDeadHold(outcome === 'slot_unavailable' ? 'slot_conflict' : 'reservation_expired');");
    // Same staleness guard as the rescue — a late verdict must not overwrite
    // a committed accept.
    expect(wrapper).toMatch(/\['submitting', 'success', 'slot_conflict', 'reservation_expired'\]\.includes\(ctaPhaseRef\.current\)/);
    expect(wrapper.indexOf('if (stale) return outcome;')).toBeLessThan(wrapper.indexOf('recoverFromDeadHold('));
    // Every silent trigger and the manual button go through the wrapper —
    // no bare extendHold() call may remain outside it and the 0:00 rescue.
    const bare = src.match(/(?<!AndSettle)\bextendHold\(\);/g) || [];
    expect(bare).toHaveLength(0);
    expect(src).toContain('onExtendHold={extendHoldAndSettle}');
    expect(src).toContain('onExtend={extendHoldAndSettle}');
  });
  it('scopes an in-flight extend and the ceiling flag to one hold id (codex r3 P1)', () => {
    const src = pageSource;
    const fn = src.slice(src.indexOf('const extendHold = useCallback'), src.indexOf('const settleExtendOutcome'));
    // Re-picking a slot while an extend is in flight must not adopt the old
    // hold's promise — its SLOT_UNAVAILABLE would pass the new hold's
    // staleness check and discard a good hold.
    expect(fn).toContain('extendPromiseRef.current.holdId === scheduledServiceId');
    expect(fn).toContain('extendPromiseRef.current = { holdId: scheduledServiceId, promise: run };');
    expect(fn).toContain('if (extendPromiseRef.current?.promise === run) extendPromiseRef.current = null;');
    // The 60-minute ceiling belongs to the hold that hit it, not the page.
    expect(fn).toContain('if (holdLimitReachedRef.current === scheduledServiceId) return \'limit_reached\';');
    expect(fn).toContain('holdLimitReachedRef.current = scheduledServiceId;');
    expect(fn).not.toMatch(/holdLimitReachedRef\.current = true/);
    // A rate limit is not a verdict on the hold.
    expect(fn).toContain("if (r.status === 429 || r.status >= 500) return 'retryable';");
  });
  it('reopens the slot picker through one recovery path (codex r3 P1)', () => {
    const src = pageSource;
    // Slice to the callback's own dependency array, not a fixed length.
    const at = src.indexOf('const recoverFromDeadHold = useCallback');
    const fn = src.slice(at, src.indexOf('}, [loadEstimate, releaseHeldReservation]);', at) + 44);
    // Clearing the reservation is not enough: acceptance.mode still
    // described the adopted hold, and canShowSlotPicker only renders for
    // standard_slot_pick — so "pick a time again" appeared with no picker.
    expect(fn).toContain('loadEstimate({ preserveSelection: false })');
    // The hold is RELEASED before the refresh (codex r3 P1): an accept-time
    // SLOT_UNAVAILABLE rolls back and leaves the row live, so refreshing
    // first re-offers the rejected hold as existing_appointment.
    expect(fn).toContain('releaseHeldReservation(deadHoldId)');
    expect(fn.indexOf('releaseHeldReservation(deadHoldId)')).toBeLessThan(fn.indexOf('loadEstimate({ preserveSelection: false })'));
    expect(fn).toContain('const deadHoldId = reservationRef.current?.scheduledServiceId');
    expect(fn).toContain('setReservation(null);');
    expect(fn).toContain('setSlotsRefreshSignal((v) => v + 1);');
    // Both recovery callers go through it; neither repeats the reset.
    const rescue = src.slice(src.indexOf('const rescuedHoldId'), src.indexOf('const rescuedHoldId') + 1800);
    // Delegated to the shared settle so the rescue can't drift from the
    // wrapper (codex r7 P1).
    expect(rescue).toContain('return settleExtendOutcome(outcome, rescuedHoldId);');
    expect(rescue).not.toContain('setPaymentPreference(null);');
    // The accept-time 409 is the third caller — a RELOADED page's adopted
    // hold leaves acceptance.mode at existing_appointment, so this path had
    // the same no-picker dead end. (Driving it for real needs the whole
    // /data payload, which this unit suite cannot mount — hence a pin.)
    // Bounded by the handler's own end — it has grown with each round.
    const a409At = src.indexOf("const expired = body.code === 'RESERVATION_EXPIRED'");
    const accept409 = src.slice(a409At, src.indexOf('throw new Error(body.error ||', a409At));
    expect(accept409).toContain("recoverFromDeadHold(expired ? 'reservation_expired' : 'slot_conflict');");
    expect(accept409).not.toContain('setSelectedSlotMeta(null);');
  });
  it('gives a capped hold a way out — "Pick a new time" (codex r3 P2)', () => {
    const onPickNewTime = vi.fn();
    render(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 0,
      holdLimitReached: true, onExtendHold: vi.fn(), onPickNewTime,
    })} />);
    // "Keep my time" is gone at the ceiling — without this action an adopted
    // hold (whose review card has no "Go back") had no way off a 0:00 screen.
    expect(screen.queryByRole('button', { name: 'Keep my time' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a new time' }));
    expect(onPickNewTime).toHaveBeenCalledTimes(1);
  });

  it('offers no "Pick a new time" while the hold is still extendable', () => {
    render(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 150,
      onExtendHold: vi.fn(), onPickNewTime: vi.fn(),
    })} />);
    expect(screen.getByRole('button', { name: 'Keep my time' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick a new time' })).not.toBeInTheDocument();
  });

  it('settles an authoritative expired extend, not only slot_unavailable (codex r3 P2)', () => {
    const src = pageSource;
    const wrapper = SETTLE;
    expect(wrapper).toContain("if (outcome !== 'slot_unavailable' && outcome !== 'expired' && outcome !== 'no_booking') return outcome;");
    expect(wrapper).toContain("recoverFromDeadHold(outcome === 'slot_unavailable' ? 'slot_conflict' : 'reservation_expired');");
  });
  it('hides "Pick a new time" while a confirmation is in flight (codex r3 P1)', () => {
    const onPickNewTime = vi.fn();
    render(<ReviewPhase {...reviewProps({
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 0,
      holdLimitReached: true, submitting: true, onExtendHold: vi.fn(), onPickNewTime,
    })} />);
    // Recovery clears the reservation and unmounts card capture — during
    // confirmSetup or /accept that would race a DELETE against the accept.
    expect(screen.queryByRole('button', { name: 'Pick a new time' })).not.toBeInTheDocument();
  });
  it('never recovers while inline card confirmation is running (codex r3 P1)', () => {
    const src = pageSource;
    // handleConfirm keeps ctaPhase at 'review' across confirmSetup(), so a
    // phase-only guard let an extend verdict unmount card capture mid-Stripe.
    const guards = src.match(/const stale = inlineConfirmBusyRef\.current/g) || [];
    expect(guards).toHaveLength(1);
    expect(SETTLE).toContain('const stale = inlineConfirmBusyRef.current');
    const phaseOnly = src.match(/const stale = \['submitting'/g) || [];
    expect(phaseOnly).toHaveLength(0);
  });
  it('awaits the extend verdict before accepting, and stops on a definitive one (codex r4 P1)', () => {
    const src = pageSource;
    // Launching the extend and /accept together let the preflight read a row
    // the extend was about to delete; once accept set phase 'submitting' the
    // extend's staleness guard suppressed its own conflict recovery.
    // `let holdOutcome` + try/finally now, so the latch is released either way.
    const awaited = src.match(/holdOutcome = await extendHoldAndSettle\(\);/g) || [];
    // Four: card-hold, recurring-card, inline capture, and the DEPOSIT path —
    // the one where the customer has already paid (codex r8 P1).
    expect(awaited).toHaveLength(4);
    const stops = src.match(/if \(holdOutcome === 'slot_unavailable' \|\| holdOutcome === 'expired'/g) || [];
    expect(stops).toHaveLength(4);
    // Go back stays clickable across that await (inlineConfirmBusy is
    // cleared, phase still 'review') and leaves the hold live server-side —
    // so each site re-validates phase AND hold identity afterwards, or it
    // would accept the abandoned review's selections (codex r4 P1).
    const captured = src.match(/const holdBeforeExtend = reservationRef\.current\?\.scheduledServiceId \|\| null;/g) || [];
    expect(captured).toHaveLength(4);
    const revalidated = src.match(/\(reservationRef\.current\?\.scheduledServiceId \|\| null\) !== holdBeforeExtend\) return;/g) || [];
    expect(revalidated).toHaveLength(4);
    // A second Confirm must not start /accept alongside the running
    // extension (codex r5 P1): the capture latch is already released and the
    // SetupIntent id is populated by then. The handoff latch is its own ref —
    // reusing inlineConfirmBusyRef would suppress the extend's own dead-hold
    // recovery and trade a race for a stuck page.
    // Four sites: the three card-success handoffs plus the prepay-quote
    // round trip (codex r6 P1), which is awaited behind the same latch.
    const latched = src.match(/confirmHandoffRef\.current = true;/g) || [];
    expect(latched).toHaveLength(5);
    const released = src.match(/confirmHandoffRef\.current = false;/g) || [];
    expect(released).toHaveLength(5);
    // No extend trigger is fire-and-forget any more.
    expect(src).not.toMatch(/\n\s+extendHoldAndSettle\(\);\n\s+return;/);
    expect(src).toContain('if (inlineConfirmBusyRef.current || confirmHandoffRef.current) return;');
    // The staleness guards still read ONLY inlineConfirmBusyRef.
    const staleGuards = src.match(/const stale = inlineConfirmBusyRef\.current/g) || [];
    expect(staleGuards).toHaveLength(1);
  });

  it('refreshes only after the hold is provably released (codex r4 P2)', () => {
    const src = pageSource;
    const rel = src.slice(src.indexOf('const releaseHeldReservation = useCallback'), src.indexOf('const recoverFromDeadHold = useCallback'));
    // fetch resolves for 429/500, and a swallowed network error looked like
    // success — so the refresh could re-adopt the hold it was recovering from.
    expect(rel).toContain('.then((r) => r.ok || r.status === 404).catch(() => false);');
    const at = src.indexOf('const recoverFromDeadHold = useCallback');
    const rec = src.slice(at, src.indexOf('}, [loadEstimate, releaseHeldReservation]);', at) + 44);
    expect(rec).toContain('if (!released) {');
    expect(rec).toContain('setRecoveryStuck(true);');
    expect(rec.indexOf('if (!released) {')).toBeLessThan(rec.indexOf('loadEstimate({ preserveSelection: false })'));
  });
  it('retries a failed recovery from the banner, not just the slot fetch (codex r4 P1)', () => {
    const src = pageSource;
    const at = src.indexOf('const recoverFromDeadHold = useCallback');
    const rec = src.slice(at, src.indexOf('}, [loadEstimate, releaseHeldReservation]);', at) + 44);
    // The hold is remembered until BOTH the release and the refresh land…
    expect(rec).toContain('pendingRecoveryHoldRef.current = deadHoldId;');
    expect(rec).toContain('pendingRecoveryHoldRef.current = null;');
    // …and a retry can still find it after the reservation was cleared.
    expect(rec).toContain('|| pendingRecoveryHoldRef.current');
    // Retry re-runs the recovery rather than only bumping the slot signal.
    const banner = src.slice(src.indexOf('const slotIssueBanner ='), src.indexOf('const slotIssueBanner =') + 900);
    expect(banner).toContain('if (pendingRecoveryHoldRef.current) {');
    expect(banner).toContain('recoverFromDeadHold(');
  });

  it('does not arm a 1s interval when the countdown starts at zero (codex r5 P2)', () => {
    const src = pageSource;
    const eff = src.slice(src.indexOf('const tick = () => {'), src.indexOf('}, [reservation, extendHold, settleExtendOutcome]);'));
    // A retryable/429 rescue leaves the reservation in place, so an interval
    // armed on an already-zero clock re-fired /extend every second and burned
    // the shared reserve limiter.
    expect(eff).toContain('return remaining;');
    expect(eff).toContain('const startedAtZero = tick() === 0;');
    expect(eff).toContain('if (startedAtZero) return undefined;');
    expect(eff.indexOf('if (startedAtZero) return undefined;')).toBeLessThan(eff.indexOf('setInterval(tick, 1000)'));
  });
  it('settles any outstanding extension at the single acceptance boundary (codex r6 P1)', () => {
    const src = pageSource;
    // Per-trigger awaits cover the card paths, but review entry, the manual
    // button and the 0:00 rescue can be in flight when a saved-card confirm
    // walks straight into performAccept.
    const wrapper = WRAPPER;
    expect(wrapper).toContain('extendSettleRef.current = settling;');
    expect(wrapper).toContain('if (extendSettleRef.current === settling) extendSettleRef.current = null;');

    // Bounded by the guard clause itself rather than a fixed length — the
    // boundary has grown with each round.
    const acceptAt = src.indexOf('const performAccept = useCallback');
    const accept = src.slice(acceptAt, src.indexOf("setCtaPhase('submitting');", acceptAt) + 40);
    expect(accept).toContain('const pending = await extendSettleRef.current.catch(() => \'retryable\');');
    expect(accept).toContain("if (pending === 'slot_unavailable' || pending === 'expired') {");
    // Settled BEFORE the single-flight latch and the phase flip, so a
    // definitive failure leaves the page able to accept again after a re-pick.
    expect(accept.indexOf('extendSettleRef.current')).toBeLessThan(accept.indexOf('acceptInFlightRef.current = true;'));
    expect(accept.indexOf('extendSettleRef.current')).toBeLessThan(accept.indexOf("setCtaPhase('submitting')"));
    // Nothing is busy across that wait, so Go back is clickable and leaves
    // the hold live — the review must be re-validated after it (codex r6 P1).
    expect(accept).toContain('const holdBeforeBoundary = reservationRef.current?.scheduledServiceId || null;');
    expect(accept).toContain('const holdChanged = (reservationRef.current?.scheduledServiceId || null) !== holdBeforeBoundary;');
    // The identity/phase guard runs BEFORE the definitive branch (codex r6
    // P1): a stale 'expired' acted on first would release the hold the
    // customer just re-selected.
    expect(accept.indexOf('if (holdChanged || phaseMovedOn) return;'))
      .toBeLessThan(accept.indexOf("if (pending === 'slot_unavailable' || pending === 'expired') {"));
    // The 0:00 rescue calls extendHold directly, so it publishes its own
    // settlement or acceptance could still race it.
    const rescue = src.slice(src.indexOf('const rescue = extendHold().then'), src.indexOf('const rescue = extendHold().then') + 2200);
    expect(rescue).toContain('extendSettleRef.current = rescue;');
    expect(rescue).toContain('if (extendSettleRef.current === rescue) extendSettleRef.current = null;');
    expect(rescue).toContain("return 'retryable';");
  });
  it('starts no new extension once an accept is in flight (codex r6 P1)', () => {
    const src = pageSource;
    const fn = src.slice(src.indexOf('const extendHold = useCallback'), src.indexOf('const settleExtendOutcome'));
    // /accept may have read the hold but not taken its locks; an extension
    // landing in that gap can delete a conflicting hold first, and the
    // rescue's own recovery is then suppressed by the 'submitting' phase.
    expect(fn).toContain("if (acceptInFlightRef.current) return 'skipped';");
    expect(fn.indexOf("if (acceptInFlightRef.current) return 'skipped';"))
      .toBeLessThan(fn.indexOf('const scheduledServiceId = reservationRef.current?.scheduledServiceId;'));
  });
  it('does not re-arm the rescue on a capped no-op (codex r7 P2)', () => {
    const src = pageSource;
    const fn = src.slice(src.indexOf('const extendHold = useCallback'), src.indexOf('const settleExtendOutcome'));
    // The server's capped no-op answers 200 with the SAME expiry; a new
    // reservation object re-runs the countdown effect, which at a sub-second
    // remainder immediately fires another zero-tick rescue — a state-driven
    // loop that burns the 10/min reserve limiter.
    expect(fn).toContain('if (!Number.isFinite(next) || (Number.isFinite(current) && next <= current)) return prev;');
  });

  it('keeps the specialized no-booking verdicts distinct from an expiry (codex r7 P2)', () => {
    const src = pageSource;
    const fn = src.slice(src.indexOf('const extendHold = useCallback'), src.indexOf('const settleExtendOutcome'));
    // Staff can reshape an estimate mid-checkout; /extend preserves those
    // bodies deliberately, and reporting them as "your hold expired" told the
    // customer to re-pick a time for a contract that books nothing.
    expect(fn).toContain('body.commercialManualScheduling || body.invoiceOnlyAcceptance || body.reviewBeforeBooking');
    // The suppression gate is the same class: every later reserve/accept
    // stays gated, so an expiry banner would be a futile retry loop.
    expect(fn).toContain("body.code === 'BERMUDA_SUPPRESSION_GATED'");
    expect(fn).toContain("return 'no_booking';");
    const wrapper = SETTLE;
    expect(SETTLE).toContain("if (outcome === 'no_booking') {");
    // Released THEN refreshed, through the shared recovery: the contract
    // prioritises existingAppointment over the no-booking modes, so a hold
    // left alive would be re-offered and re-adopted into the same refusal
    // (codex r7 P1).
    expect(SETTLE).toContain("recoverFromDeadHold('configure');");
    // The staleness guard precedes EVERY state-changing branch (codex r7 P1)
    // — a no_booking landing mid-confirmSetup must not unmount card capture.
    expect(SETTLE.indexOf('if (stale) return outcome;'))
      .toBeLessThan(SETTLE.indexOf("if (outcome === 'no_booking') {"));
    // And the accept latch drops before the prepay-quote extension, or
    // extendHold would refuse to run at all.
    expect(pageSource).toContain('acceptInFlightRef.current = false;\n          confirmHandoffRef.current = true;');
  });
  it('extends before accepting a PAID deposit, and never re-charges on recovery (codex r8 P1)', () => {
    const src = pageSource;
    const fn = src.slice(src.indexOf('const handleDepositSuccess = useCallback'), src.indexOf('const handleDepositCancel'));
    // The modal can outlast the hold, and a rescue that already settled on a
    // retryable miss leaves the acceptance boundary nothing to await — so
    // /accept answered RESERVATION_EXPIRED and a paying customer had no visit.
    expect(fn).toContain('holdOutcome = await extendHoldAndSettle();');
    expect(fn).toContain("if (holdOutcome === 'slot_unavailable' || holdOutcome === 'expired' || holdOutcome === 'no_booking') return;");
    // The payment intent survives the recovery, so the accept after a re-pick
    // replays it instead of charging again.
    expect(fn).toContain('depositPaymentIntentIdRef.current = paymentIntentId;');
    expect(fn).not.toMatch(/depositPaymentIntentIdRef\.current = null/);
  });
  it('tells the truth about a HELD row, with its clock, before payment selection (codex r9 P1)', () => {
    render(<ExistingAppointmentCard
      appointment={{ isHold: true, scheduledDate: '2026-09-16', windowStart: '09:00', serviceType: 'Lawn Care' }}
      secondsRemaining={754}
    />);
    expect(screen.getByText('Time held for you')).toBeInTheDocument();
    // "already on the schedule" is how a customer walked away believing she
    // was booked while the hold lapsed.
    expect(screen.queryByText(/already on the schedule/)).not.toBeInTheDocument();
    expect(screen.getByText(/12:34 left/)).toBeInTheDocument();
    expect(screen.getByText(/not booked until you choose how to pay/)).toBeInTheDocument();
  });

  it('leaves a genuinely committed appointment\'s copy alone', () => {
    render(<ExistingAppointmentCard
      appointment={{ scheduledDate: '2026-09-16', windowStart: '09:00', serviceType: 'Lawn Care' }}
    />);
    expect(screen.getByText('Existing appointment')).toBeInTheDocument();
    expect(screen.getByText(/already on the schedule/)).toBeInTheDocument();
  });
  it('starts the adopted-hold clock at load, not at payment selection (codex r9 P1)', () => {
    const src = pageSource;
    const eff = src.slice(src.indexOf('// A RELOADED page must start the clock immediately'), src.indexOf('// ONE place that turns an extend outcome into page state'));
    // Hydrating only inside handlePaymentChoice meant a customer could read
    // the estimate for the whole hold with no clock and no 0:00 rescue.
    expect(eff).toContain('existingAppointment?.isHold && existingAppointment?.reservationExpiresAt');
    expect(eff).toContain('scheduledServiceId: held.id,');
    expect(eff).toContain('adoptedHold: true,');
    // Re-seeding the same hold+expiry would restart the countdown; a live
    // reservation for a DIFFERENT hold must not be clobbered.
    expect(eff).toContain("if (prev && prev.scheduledServiceId === held.id && prev.expiresAt === held.reservationExpiresAt) return prev;");
    expect(eff).toContain('if (prev && prev.scheduledServiceId && prev.scheduledServiceId !== held.id) return prev;');
    // Keyed so a /data refresh that advances the expiry re-seeds.
    // Re-seeds when configure state clears `reservation` without releasing
    // the server hold — "Go back", a frequency change, a service-mode change
    // (codex r12 P1). Idempotent, so it cannot loop.
    expect(eff).toContain('reservation?.scheduledServiceId, ctaPhase]');
    // …but NOT while a recovery is releasing that hold, and not in a
    // terminal phase (codex r12 P1) — hydrating there restored the hold
    // being deleted and restarted its countdown.
    expect(eff).toContain('if (recoveryInFlightRef.current || recoveryStuckRef.current) return;');
    expect(eff).toContain("if (['submitting', 'success', 'slot_conflict', 'reservation_expired'].includes(ctaPhase)) return;");
    // And a refresh that drops the hold clears the one we seeded, leaving a
    // fresh slot pick alone.
    expect(eff).toContain("setReservation((prev) => (prev?.adoptedHold ? null : prev));");
  });
  it('gives a stuck recovery its own banner and retry, in any phase (codex r10 P2)', () => {
    const src = pageSource;
    // A no_booking recovery lands on 'configure', which has no slot banner,
    // so a failed release left the stale contract with nothing to tap.
    expect(src).toContain('const [recoveryStuck, setRecoveryStuck] = useState(false);');
    expect(src).toContain('setRecoveryStuck(true);');
    expect(src).toContain('const slotIssueBanner = recoveryStuck ? (');
    expect(src).toContain('kind="stale_hold"');
    // Cleared only when release AND reload both land.
    const at = src.indexOf('const recoverFromDeadHold = useCallback');
    const rec = src.slice(at, src.indexOf('}, [loadEstimate, releaseHeldReservation]);', at));
    expect(rec).toContain('pendingRecoveryHoldRef.current = null;');
    expect(rec).toContain('setRecoveryStuck(false);');
  });

  it('never promises a HELD row stays scheduled, in any payment branch (codex r10 P1)', () => {
    const src = pageSource;
    // Every adopted-hold lede goes through existingApptLede; the only literal
    // left is the committed-appointment one inside that ternary.
    const literals = src.match(/'Your existing appointment stays scheduled\./g) || [];
    expect(literals).toHaveLength(1);
    expect(src).toContain("? 'Your held time is confirmed when you finish here.'");
  });

  it('shows tentative copy for a held row in the review lede', () => {
    render(<ReviewPhase {...reviewProps({
      existingAppointment: { id: 'appt-1', isHold: true, scheduledDate: '2026-09-16', windowStart: '09:00' },
      holdExpiresAt: '2026-09-11T19:00:00.000Z', secondsRemaining: 300,
      paymentPreference: 'pay_at_visit', onExtendHold: vi.fn(),
    })} />);
    expect(screen.getByText(/Your held time is confirmed when you finish here/)).toBeInTheDocument();
    expect(screen.queryByText(/stays scheduled/)).not.toBeInTheDocument();
  });
  it('locks payment choices until recovery releases and reloads (codex r11 P2)', () => {
    const src = pageSource;
    // Until the DELETE and the /data refresh both land, acceptance still
    // describes the dead hold — so a payment tap would re-adopt the very hold
    // recovery is deleting, or one it could not delete.
    expect(src).toContain('const [recoveryInFlight, setRecoveryInFlight] = useState(false);');
    const disabled = src.match(/recoveryInFlight \|\| recoveryStuck\}/g) || [];
    expect(disabled).toHaveLength(2);
    // …and a synchronous guard, because `disabled` does not stop a retained
    // callback in the same frame.
    expect(src).toContain('if (recoveryInFlightRef.current || recoveryStuckRef.current) return;');
    // Both refs track their state everywhere it moves.
    expect((src.match(/recoveryInFlightRef\.current = /g) || []).length).toBeGreaterThanOrEqual(4);
    expect((src.match(/recoveryStuckRef\.current = /g) || []).length).toBeGreaterThanOrEqual(4);
  });
  it('stops claiming a spent hold is held on the configure card, and offers a way out (codex r16 P2)', () => {
    const onPickNewTime = vi.fn();
    // At the 60-minute ceiling, on the configure screen — ReviewPhase (and
    // its "Pick a new time") is not rendered until a payment option is
    // chosen, so this card was the only thing on screen.
    render(<ExistingAppointmentCard
      appointment={{ isHold: true, scheduledDate: '2026-09-16', windowStart: '09:00' }}
      secondsRemaining={0}
      holdLimitReached
      onPickNewTime={onPickNewTime}
    />);
    expect(screen.getByText('Time no longer held')).toBeInTheDocument();
    expect(screen.queryByText(/This time is held while you finish/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a new time' }));
    expect(onPickNewTime).toHaveBeenCalledTimes(1);
  });

  it('still shows the live clock while the hold has time left', () => {
    render(<ExistingAppointmentCard
      appointment={{ isHold: true, scheduledDate: '2026-09-16', windowStart: '09:00' }}
      secondsRemaining={120}
      onPickNewTime={vi.fn()}
    />);
    expect(screen.getByText('Time held for you')).toBeInTheDocument();
    expect(screen.getByText(/2:00 left/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pick a new time' })).not.toBeInTheDocument();
  });
  it('refuses recovery mid-confirmation at the chokepoint, not per button (codex r16 P1)', () => {
    const src = pageSource;
    const at = src.indexOf('const recoverFromDeadHold = useCallback');
    const rec = src.slice(at, src.indexOf('}, [loadEstimate, releaseHeldReservation]);', at));
    // Recovery clears the reservation, unmounts capture and DELETEs the hold;
    // during confirmSetup or the card handoff that cancels a hold the
    // confirmation is about to use. Guarded inside the recovery so every
    // caller — including ones added later — inherits it.
    expect(rec).toContain('if (inlineConfirmBusyRef.current) return;');
    // Scoped to the Stripe confirmation ONLY. The card/deposit handoffs set
    // confirmHandoffRef around their awaited extend, where settling a
    // definitive verdict is exactly what must happen — guarding on it left a
    // customer on review with a dead hold and no banner after paying a
    // deposit. acceptInFlightRef is out for the same reason: the accept's own
    // 409 handler recovers while that latch is set.
    expect(rec).not.toContain('confirmHandoffRef.current');
    expect(rec).not.toContain('acceptInFlightRef.current');
    expect(rec.indexOf('if (inlineConfirmBusyRef.current) return;'))
      .toBeLessThan(rec.indexOf('setCtaPhase(phase);'));
  });

  it('hides the appointment card\'s recovery action while confirming', () => {
    render(<ExistingAppointmentCard
      appointment={{ isHold: true, scheduledDate: '2026-09-16', windowStart: '09:00' }}
      secondsRemaining={0}
      holdLimitReached
      onPickNewTime={vi.fn()}
      busy
    />);
    expect(screen.queryByRole('button', { name: 'Pick a new time' })).not.toBeInTheDocument();
    // The copy still tells the truth about the hold.
    expect(screen.getByText('Time no longer held')).toBeInTheDocument();
  });
  it('treats accept\'s no-booking 409s like the extend ones (codex r17 P2)', () => {
    const src = pageSource;
    const at = src.indexOf("const expired = body.code === 'RESERVATION_EXPIRED'");
    const handler = src.slice(at, at + 1400);
    // A reshape landing after the last successful extension comes back from
    // /accept with these bodies; slot_conflict told the customer their slot
    // was taken and offered slot-retry UX for a flow that books nothing.
    expect(handler).toContain('body.commercialManualScheduling || body.invoiceOnlyAcceptance || body.reviewBeforeBooking');
    expect(handler).toContain("body.code === 'BERMUDA_SUPPRESSION_GATED'");
    expect(handler).toContain("recoverFromDeadHold('configure');");
    // …and it is checked BEFORE the expired/slot_conflict split.
    expect(handler.indexOf("recoverFromDeadHold('configure');"))
      .toBeLessThan(handler.indexOf("recoverFromDeadHold(expired ?"));
  });
});
