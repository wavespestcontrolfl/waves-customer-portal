// Check out appointment — mobile-only, full-screen sheet opened from
// MobileAppointmentDetailSheet's "Review & checkout" CTA. Square-style
// layout per IMG_3729: Charge button up top, service line items below,
// Add Service / Add Item or Discount buttons at the bottom.
//
// "Charge" mints an invoice via POST /admin/schedule/:id/invoice and hands
// the invoice id + total to MobilePaymentSheet, which picks the payment
// method. Added services + discounts are sent as extraLineItems in the
// request body (negative amounts for discounts).
//
// Audit focus:
// - Discount math — only manually added discounts reduce the charge preview.
//   Customer WaveGuard tier is displayed as billing context, not as an
//   automatically applied discount.
// - Charge → invoice → payment handoff: the invoice id + total are
//   passed to MobilePaymentSheet via parent state. Confirm the parent
//   doesn't allow re-clicking "Charge" before the first invoice POST
//   resolves (would create duplicate invoices).
// - extraLineItems shape: discounts go in as negative amounts. Server
//   should validate sign + cap; verify there's no client path that
//   could submit an unbounded negative discount.
// - Mobile sheet stack: this sheet opens MobileServicePickerSheet and
//   MobileItemDiscountPickerSheet as child sheets. Dismiss / re-open /
//   ESC behavior should restore the parent's scroll position and not
//   leak focus.

import { createPortal } from 'react-dom';
import { stackDiscounts, percentageDiscountDollars, stackGroupConflict } from '../../lib/discountStack';
import { useDiscountStackingState, ensureStackingFresh } from '../../hooks/useDiscountStacking';
import { X, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';
import MobileServicePickerSheet from './MobileServicePickerSheet';
import MobileItemDiscountPickerSheet from './MobileItemDiscountPickerSheet';
import {
  useCustomerCards,
  chargeableCardOnFile,
  cardOnFileTitle,
  isCardExpired,
} from '../../hooks/useCustomerCards';
import { attachedVisitInvoice } from './visitInvoice';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function tierLabel(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return '';
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h24 = parseInt(m[1], 10);
  const mm = m[2];
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${mm} ${ap}`;
}

// Generate a short client-side id for tracking added rows.
let _uid = 0;
const uid = () => `ex_${Date.now()}_${++_uid}`;

export default function MobileCheckoutSheet({
  service,
  onClose,
  onChargeSuccess,
  onEditServiceLine,
  desktopVisible = false,
}) {
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState(null);
  const [extras, setExtras] = useState([]);
  // { id, description, unit_price, quantity, amount, _kind }
  //   _kind is 'service' | 'discount' (UI label only — server treats uniformly)
  const [showServicePicker, setShowServicePicker] = useState(false);
  const [showItemPicker, setShowItemPicker] = useState(false);
  // Saved payment methods — shown under the Charge button so the tech knows
  // whether a card is on file before picking a tender. null = unknown
  // (loading / fetch failed) and renders nothing: a false "No card on file"
  // would send the tech chasing cash from an autopay customer.
  const { cards: cardsOnFile } = useCustomerCards(service?.customerId || service?.customer_id);
  // Deploy-wide release gate (GATE_DISCOUNT_STACKING); fails closed to the
  // pre-lane preview, which is what the mint endpoint then stores.
  const { enabled: stackingEnabled, known: stackingKnown, retry: retryStackingProbe } = useDiscountStackingState();

  if (!service) return null;

  const tier = service.waveguardTier ? String(service.waveguardTier).toLowerCase() : null;
  const rawPrice = service.estimatedPrice != null ? Number(service.estimatedPrice) : null;
  // Callbacks (re-services) are free by definition for recurring/WaveGuard
  // customers — the server zeroes the visit and won't bill monthly dues, so the
  // checkout preview must not fall back to monthlyRate (which would show a
  // "Charge $<rate>" button that the mint endpoint then rejects as $0).
  const price = rawPrice != null ? rawPrice : (service.isCallback ? 0 : Number(service.monthlyRate || 0));
  const appointmentAddons = Array.isArray(service.serviceAddons) ? service.serviceAddons : [];
  const appointmentAddonTotal = Math.round(
    appointmentAddons.reduce((sum, addon) => sum + (Number(addon.estimatedPrice) || 0), 0) * 100
  ) / 100;
  const splitAppointmentAddons = appointmentAddons.length > 0 && appointmentAddonTotal > 0 && appointmentAddonTotal < price;
  const baseServicePrice = splitAppointmentAddons
    ? Math.max(0, Math.round((price - appointmentAddonTotal) * 100) / 100)
    : price;
  const baseServiceLabel = splitAppointmentAddons
    ? (service.serviceType || 'General Service')
    : (service.serviceTypeDisplay || service.serviceType || 'General Service');

  // Separate extras: positive-amount services vs negative-amount discounts.
  // All discounts are manual rows added by the operator. Every discount
  // stacks on the services base the way the mint endpoint does
  // (lib/discountStack mirrors services/discount-stack): fixed credits
  // first, then percentages compounding on what is left — re-derived on
  // every change so the rows always show what will be charged.
  const extraServicesTotal = useMemo(() => extras.reduce(
    (sum, e) => (Number(e.amount) >= 0 ? sum + Number(e.amount) : sum), 0,
  ), [extras]);
  const servicesSubtotal = price + extraServicesTotal;
  // Codex GitHub round 1 P1 (PR #4658): gate dark (or its probe unresolved —
  // stackingEnabled already fails closed to false) must stay BYTE-IDENTICAL
  // to before this lane: each row keeps the dollar amount SNAPSHOTTED at
  // selection time (handleAddItem) and is never recomputed as services are
  // added or removed afterward — compound:false was only ever additive vs.
  // sequential math, not a snapshot, so it still recomputed against a
  // moving servicesSubtotal. Only the gate-ON path re-derives live through
  // the shared engine.
  const { stackedDiscountRows, extraDiscountsTotal, discountRegimeDependent } = useMemo(() => {
    // Codex GitHub round 2 P1 (PR #4658): select discount ROWS by _kind,
    // never by their (possibly stale, possibly -0) stored dollar amount —
    // a percentage picked while the base is $0 (a free callback, before
    // any paid service is added) snapshots a provisional -0 that a
    // Number(e.amount) < 0 filter drops from the stack FOREVER, since
    // nothing ever writes a recomputed value back into e.amount itself.
    // That silently excluded the row from every later live recompute too,
    // so adding a paid service afterward left it out of both the preview
    // and the submitted payload.
    const discountExtras = extras.filter((e) => e._kind === 'discount');
    if (discountExtras.length === 0) {
      return { stackedDiscountRows: new Map(), extraDiscountsTotal: 0, discountRegimeDependent: false };
    }
    const snapshotTotal = discountExtras.reduce((sum, e) => sum + Number(e.amount), 0);
    const stacked = stackDiscounts(servicesSubtotal, discountExtras.map((e) => (
      e.discount_type
        ? {
          discountType: e.discount_type,
          amount: e.discount_amount,
          maxDiscountDollars: e.max_discount_dollars,
          // Codex GitHub round 1 P2 (PR #4658): the stable catalog identity
          // rides along so stackOrder's identity tiebreak — not click
          // order / array position — decides which of two otherwise-tying
          // discounts (same type/value/cap/scope) resolves first.
          id: e.discount_id ?? e.discount_key ?? undefined,
        }
        : { discountType: 'fixed_amount', amount: Math.abs(Number(e.amount) || 0) }
    )), { compound: true });
    const liveTotal = -stacked.totalDollars;
    // Codex GitHub round 3 P1 (PR #4658): a SINGLE percentage discount's
    // resolved amount can also diverge between regimes whenever the base
    // moved after selection — gate-off keeps the selection-time snapshot,
    // gate-on recomputes against whatever the base is NOW — so "2+ rows"
    // was never the right bar for revalidating before Charge. Compare what
    // gate-off would post (the snapshot total) against what gate-on would
    // post (the live recompute) directly: any difference at the cent means
    // the submitted amount depends on which regime the server is actually
    // running right now, independent of row count.
    const regimeDependent = Math.round(snapshotTotal * 100) !== Math.round(liveTotal * 100);
    if (!stackingEnabled) {
      return { stackedDiscountRows: new Map(), extraDiscountsTotal: snapshotTotal, discountRegimeDependent: regimeDependent };
    }
    const rows = new Map();
    discountExtras.forEach((e, i) => rows.set(e.id, stacked.items[i].dollars));
    return { stackedDiscountRows: rows, extraDiscountsTotal: liveTotal, discountRegimeDependent: regimeDependent };
  }, [extras, servicesSubtotal, stackingEnabled]);
  const extraAmount = (e) => (stackedDiscountRows.has(e.id) ? -stackedDiscountRows.get(e.id) : Number(e.amount));
  // Codex #4405 P1, generalized by GitHub round 3 P1 (PR #4658): Charge
  // must not fire while the stacking gate's real state is unconfirmed AND
  // the submitted amount actually depends on which regime is live —
  // discountRegimeDependent (not a bare row count) is the right bar: a
  // SINGLE percentage discount is exactly as exposed as two once its base
  // has moved since selection (round 3), while two rows that happen to
  // total the same either way need no gate at all.
  const stackingUnconfirmedBlocksCharge = !stackingKnown && discountRegimeDependent;
  // Codex GitHub round 3 P1 (PR #4658): the picker's OWN non-stackable-
  // group hiding is suppressed whenever chosenDiscounts is empty — which
  // is every row picked while the probe was still unknown (chosenDiscounts
  // fails closed to stackingEnabled:false, i.e. []). A technician can
  // therefore add two non-stackable tiers (WaveGuard Silver AND Gold)
  // before the probe resolves, and nothing re-validated the ALREADY-PICKED
  // rows afterward — the route would record both as separate
  // validated_checkout stamps. Runs UNCONDITIONALLY (not gated on
  // stackingEnabled/stackingKnown): one non-stackable tier per checkout is
  // a baseline invariant the server enforces regardless of
  // GATE_DISCOUNT_STACKING, so there is nothing to wait on here.
  const discountGroupConflict = useMemo(() => stackGroupConflict(
    extras.filter((e) => e._kind === 'discount').map((e) => ({
      id: e.discount_id, name: e.description, stack_group: e.stack_group, is_stackable: e.is_stackable,
    })),
  ), [extras]);

  const prepaidAmount = service.prepaidAmount != null ? Math.max(0, Number(service.prepaidAmount) || 0) : 0;
  // An open invoice already attached to this visit (accept-minted setup +
  // first-application invoice, or an earlier Charge-now mint) is what the
  // charge actually collects — the mint endpoint reuses it AS-IS and ignores
  // extraLineItems. Preview its total instead of the per-application price
  // (e.g. a $214 first-visit invoice on a $115/application plan), and drop
  // the add-service/discount affordances that would silently do nothing.
  const inv = attachedVisitInvoice(service);
  // Payer-billed visits never collect in person — the Charge-now endpoint
  // refuses them and AR routes to the payer's AP inbox — so an attached
  // invoice must not be presented as collectible here. Use the SERVER-
  // RESOLVED signals only: `billedToPayer` (active payer resolution) and the
  // invoice's own payer flag (via inv.open). Raw payerId is deliberately NOT
  // consulted — an inactive per-job payer resolves self-pay and the visit's
  // invoice IS collectible.
  const payerBilled = !!service.billedToPayer;
  const openVisitInvoice = !payerBilled && inv && inv.open && inv.total > 0 ? inv : null;
  // A processing invoice is money already in flight (e.g. a pending ACH
  // debit) — the payment routes reject it, so block charging outright
  // instead of falling back to a preview that fails after tender pick.
  const processingVisitInvoice = !payerBilled && !inv?.payerBilled && inv && inv.processing ? inv : null;
  const invoicePreview = openVisitInvoice || processingVisitInvoice;
  // amountDue (total − credit_applied), never the gross — the charge paths
  // collect the amount due. And when the recorded prepayment was already
  // consumed by this invoice (prepaidApplied), its total is already net, so
  // netting service.prepaidAmount again would understate the button.
  const totalBeforePrepaid = invoicePreview
    ? invoicePreview.amountDue
    : Math.max(0, servicesSubtotal + extraDiscountsTotal);
  const prepaidCredit = invoicePreview && invoicePreview.prepaidApplied
    ? 0
    : Math.min(prepaidAmount, totalBeforePrepaid);
  const total = Math.max(0, totalBeforePrepaid - prepaidCredit);
  // A genuinely $0 visit (e.g. a free callback with no added extras) has nothing
  // to mint — the invoice endpoint rejects a zero charge — so disable the Charge
  // button and point the tech at completing the job. Base this on the PRE-prepaid
  // chargeable amount: a positive-price visit that's fully prepaid still needs to
  // mint its invoice (the endpoint applies the prepaid credit → paid receipt), so
  // it must stay enabled even though `total` nets to $0.
  const nothingToCharge = totalBeforePrepaid <= 0 || !!processingVisitInvoice;

  // One-line card-on-file note for the tech. Shows the first non-expired
  // method (server orders default first); if every method is expired, says
  // so rather than claiming there's no card.
  let cardOnFileNote = null;
  if (Array.isArray(cardsOnFile)) {
    const card = chargeableCardOnFile(cardsOnFile);
    if (!card) {
      cardOnFileNote = 'No card on file';
    } else {
      const kind = card.method_type === 'ach' ? 'Bank' : 'Card';
      const expired = isCardExpired(card) ? ` (expired ${card.exp_month}/${card.exp_year})` : '';
      const more = cardsOnFile.length > 1 ? ` · +${cardsOnFile.length - 1} more` : '';
      cardOnFileNote = `${kind} on file: ${cardOnFileTitle(card)}${expired}${more}`;
    }
  }

  const startTime = formatTime(service.windowStart);
  const duration = service.estimatedDuration ? `${service.estimatedDuration} mins` : '';
  const timeSubtitle = [startTime, duration].filter(Boolean).join(' · ');
  const billingSubtitle = tier
    ? `WaveGuard ${tierLabel(tier)} | Monthly autopay`
    : 'Single visit';

  const handleAddService = (svc) => {
    setShowServicePicker(false);
    const isVariable = svc.pricing_type === 'variable' || svc.pricing_type === 'quoted' || !(Number(svc.base_price) > 0);
    let unitPrice = Number(svc.base_price || 0);
    if (isVariable) {
      const input = window.prompt(`Price for ${svc.name}:`, unitPrice > 0 ? String(unitPrice) : '0');
      if (input == null) return;
      const n = Number(input);
      if (!Number.isFinite(n) || n <= 0) return;
      unitPrice = n;
    }
    setExtras((prev) => [...prev, {
      id: uid(),
      _kind: 'service',
      description: svc.name,
      quantity: 1,
      unit_price: unitPrice,
      amount: unitPrice,
      category: svc.category || null,
    }]);
  };

  const handleAddItem = (payload) => {
    setShowItemPicker(false);
    if (!payload) return;
    if (payload.kind === 'custom_amount') {
      setExtras((prev) => [...prev, {
        id: uid(),
        _kind: payload.amount < 0 ? 'discount' : 'service',
        description: payload.label || 'Custom Item',
        quantity: 1,
        unit_price: payload.amount,
        amount: payload.amount,
      }]);
      return;
    }
    // Discount (library row OR custom_discount)
    const d = payload.kind === 'discount' ? payload.discount : payload;
    const amt = Number(d.amount || 0);
    if (!amt) return;
    const isPercent = d.discount_type === 'percentage' || d.discount_type === 'variable_percentage';
    // Codex GitHub round 2 P1 (PR #4658): this snapshot is what gate-off
    // posts verbatim (never recomputed — round 1's fix) AND what a
    // gate-on row shows before the live memo below takes over, so it must
    // already be cent-exact — plain float division rounds 5% of $20.70
    // down to $1.03 instead of $1.04, which the route's
    // Math.min(submittedDollars, resolved.dollars) then preserves even
    // though the server's own cap-check resolves the correct $1.04.
    const dollarOff = isPercent
      ? percentageDiscountDollars(servicesSubtotal, amt, d.max_discount_dollars)
      : amt;
    const label = payload.kind === 'custom_discount'
      ? (isPercent ? `Custom Discount (${amt}%)` : 'Custom Discount')
      : (d.name || 'Discount');
    setExtras((prev) => [...prev, {
      id: uid(),
      _kind: 'discount',
      discount_id: d.id || null,
      discount_key: d.discount_key || null,
      discount_type: d.discount_type || null,
      discount_amount: amt,
      max_discount_dollars: d.max_discount_dollars ?? null,
      stack_group: d.stack_group || null,
      is_stackable: d.is_stackable,
      is_waveguard_tier_discount: !!d.is_waveguard_tier_discount,
      description: isPercent ? `${label} (${amt}%)` : label,
      quantity: 1,
      unit_price: -dollarOff,
      amount: -dollarOff,
    }]);
  };

  const removeExtra = (id) => setExtras((prev) => prev.filter((e) => e.id !== id));

  async function handleCharge() {
    if (minting || nothingToCharge || stackingUnconfirmedBlocksCharge || discountGroupConflict) return;
    setMinting(true);
    setMintError(null);
    // Revalidate right before posting money: polling narrows the window after a
    // mid-session gate flip but cannot close it, and the preview on screen was
    // computed under `stackingEnabled`. Ordered AFTER setMinting so the await
    // cannot widen the double-tap window into a double charge. Codex GitHub
    // round 3 P1 (PR #4658): gated on discountRegimeDependent, not a bare
    // "2+ discounts" row count — a single percentage discount is exactly as
    // exposed as two once its base has moved since selection, and that's
    // also the bar for sending expected_discount_stacking below (mirrors
    // #4655's own client contract: a write whose total can't move with the
    // regime omits the field entirely).
    let confirmedStackingRegime = stackingEnabled;
    if (discountRegimeDependent) {
      const fresh = await ensureStackingFresh();
      if (!fresh.known || fresh.enabled !== stackingEnabled) {
        setMinting(false);
        setMintError('The discount-stacking setting changed while this was open. Reload before charging so the total matches what will be billed.');
        return;
      }
      // The LIVE value this freshness check just confirmed, not the
      // (already-equal, but one render older) value the preview used —
      // this is what actually goes on the wire.
      confirmedStackingRegime = fresh.enabled;
    }
    try {
      const body = {
        // Discount rows post their STACKED dollars (what the sheet showed);
        // the mint endpoint re-resolves and clamps either way. Service rows
        // post verbatim. Catalog-only fields stay client-side.
        extraLineItems: extras.flatMap((e) => {
          const { _kind, id: _id, max_discount_dollars: _maxDiscountDollars, stack_group: _stackGroup, is_stackable: _isStackable, ...rest } = e;
          if (_kind !== 'discount') return [rest];
          const dollars = extraAmount(e);
          // A row the stack resolved to nothing is dropped, not posted as a
          // -0 that the mint endpoint would read as a $0 SERVICE line.
          if (!(dollars < 0)) return [];
          return [{ ...rest, quantity: 1, unit_price: dollars, amount: dollars }];
        }),
        // The gate state this charge was previewed/revalidated under — the
        // server refuses a mismatch with its own retryable 409 rather than
        // silently minting the other regime's total (server/routes/
        // admin-schedule.js, mirroring #4655's InvoiceService.create /
        // calculateUpdateFinancials pattern). Omitted whenever
        // discountRegimeDependent is false: the submitted total can't move
        // with the regime, so there's nothing to bind (round 3: this is no
        // longer just "0-1 discounts" — a single discount whose base never
        // moved also has nothing to bind).
        ...(discountRegimeDependent ? { expected_discount_stacking: confirmedStackingRegime } : {}),
      };
      const r = await fetch(`${API_BASE}/admin/schedule/${service.id}/invoice`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
      const data = await r.json();
      if (!data.invoiceId) throw new Error('No invoice id returned');
      // The visit's invoice is already settled (paid, or prepaid/covered by
      // account credit) — there's nothing to collect, so don't open tender
      // options (each would fail against the terminal invoice). Tell the tech.
      if (data.alreadyPaid) {
        setMintError(
          data.status === 'prepaid'
            ? 'This visit is already covered by account credit — nothing to collect.'
            : 'This visit is already paid — nothing to collect.',
        );
        setMinting(false);
        return;
      }
      const confirmedTotal = Number(data.total);
      onChargeSuccess?.({
        service,
        invoiceId: data.invoiceId,
        invoiceToken: data.token,
        amount: Number.isFinite(confirmedTotal) ? confirmedTotal : total,
      });
    } catch (e) {
      setMintError(e.message || 'Failed to create invoice');
      setMinting(false);
    }
  }

  return createPortal(
    <div className={`fixed inset-0 z-[105] bg-white flex flex-col overflow-hidden ${desktopVisible ? '' : 'md:hidden'}`}>
      <div
        className="box-border sticky top-0 z-[1] shrink-0 bg-white border-b border-hairline border-zinc-200 flex items-center px-3"
        style={{ height: 'calc(56px + env(safe-area-inset-top, 0px))', paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center h-11 w-11 u-focus-ring text-zinc-900"
        >
          <X size={22} strokeWidth={1.75} />
        </button>
        <div className="flex-1 text-center font-medium text-zinc-900" style={{ fontSize: 16 }}>
          Check out appointment
        </div>
        <div className="w-11" />
      </div>

      <div className="box-border shrink-0 w-full px-4 py-3 mx-auto" style={{ maxWidth: 560 }}>
        <button
          type="button"
          onClick={handleCharge}
          disabled={minting || nothingToCharge || stackingUnconfirmedBlocksCharge || !!discountGroupConflict}
          className="w-full bg-zinc-900 text-white font-medium rounded-xs u-focus-ring"
          style={{ padding: '16px 20px', fontSize: 16, opacity: (minting || nothingToCharge || stackingUnconfirmedBlocksCharge || !!discountGroupConflict) ? 0.6 : 1 }}
        >
          {minting
            ? 'Opening payment…'
            : processingVisitInvoice
              ? 'Payment processing — nothing to collect'
              : nothingToCharge
                ? 'No charge — complete from job'
                : discountGroupConflict
                  ? 'Resolve discount conflict to charge'
                  : stackingUnconfirmedBlocksCharge
                    ? 'Confirm discount stacking to charge'
                    : `Charge $${total.toFixed(2)}`}
        </button>
        {discountGroupConflict && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 bg-alert-bg border border-alert-fg/30 rounded-sm px-3 py-2"
            style={{ marginTop: 8 }}
          >
            {/* Codex GitHub round 3 P1 (PR #4658): no Retry here — unlike an
                unconfirmed probe, there is nothing to re-poll. The fix is
                removing one of the two conflicting rows below. */}
            <span className="text-alert-fg" style={{ fontSize: 14 }}>
              {discountGroupConflict.names[0]} and {discountGroupConflict.names[1]} can't both apply — remove one before charging.
            </span>
          </div>
        )}
        {!discountGroupConflict && stackingUnconfirmedBlocksCharge && (
          <div
            role="alert"
            className="flex items-center justify-between gap-2 bg-alert-bg border border-alert-fg/30 rounded-sm px-3 py-2"
            style={{ marginTop: 8 }}
          >
            {/* Codex GitHub round 3 P2 (PR #4658): 12px was under the portal
                design system's 14px readability floor — this is the ONLY
                guidance the tech gets when the probe fails. */}
            <span className="text-alert-fg" style={{ fontSize: 14 }}>
              Could not confirm how multiple discounts combine — retry before charging.
            </span>
            <button
              type="button"
              onClick={retryStackingProbe}
              className="text-alert-fg border border-alert-fg rounded-sm u-focus-ring"
              style={{ padding: '4px 10px', fontSize: 14, fontWeight: 500, flex: '0 0 auto', background: 'none' }}
            >
              Retry
            </button>
          </div>
        )}
        {mintError && (
          <div role="alert" className="text-center text-alert-fg" style={{ fontSize: 12, marginTop: 6 }}>
            {mintError}
          </div>
        )}
      </div>
      <div className="box-border min-h-0 flex-1 overflow-y-auto overscroll-contain w-full px-4 pb-10 mx-auto" style={{ maxWidth: 560, paddingBottom: "calc(40px + env(safe-area-inset-bottom, 0px))" }}>
        {cardOnFileNote && (
          <div className="text-center text-ink-tertiary" style={{ fontSize: 13, marginTop: 8 }}>
            {cardOnFileNote}
          </div>
        )}

        {/* Service line items */}
        <div className="mt-6">
          {invoicePreview ? (
            <>
              {/* The attached invoice is collected as-is — its lines ARE the
                  charge preview. No edit affordance: line edits on the
                  appointment don't change an already-minted invoice. */}
              <div className="flex items-start justify-between gap-3 py-4 border-b border-hairline border-zinc-200">
                <div className="flex-1 min-w-0 pr-2">
                  <div className="font-medium text-zinc-900 truncate" style={{ fontSize: 15 }}>
                    {baseServiceLabel}
                  </div>
                  <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>
                    Invoice on file{invoicePreview.number ? ` · ${invoicePreview.number}` : ''}
                  </div>
                  {timeSubtitle && (
                    <div className="text-ink-tertiary u-nums" style={{ fontSize: 12, marginTop: 1 }}>
                      {timeSubtitle}
                    </div>
                  )}
                </div>
              </div>
              {invoicePreview.lines.map((line, i) => (
                <div
                  key={`${line.description}-${i}`}
                  className="flex items-start justify-between gap-3 py-4 border-b border-hairline border-zinc-200"
                >
                  <div className="flex-1 min-w-0 pr-2 text-zinc-900" style={{ fontSize: 15 }}>
                    {line.description}
                  </div>
                  <div className="u-nums text-zinc-900 font-medium shrink-0" style={{ fontSize: 15 }}>
                    {line.amount < 0 ? '−' : ''}${Math.abs(line.amount).toFixed(2)}
                  </div>
                </div>
              ))}
              {invoicePreview.creditApplied > 0 && (
                <div className="flex items-center justify-between gap-3 py-4 border-b border-hairline border-zinc-200">
                  <span className="text-zinc-900" style={{ fontSize: 15 }}>Account credit applied</span>
                  <span className="u-nums text-zinc-900 shrink-0" style={{ fontSize: 15 }}>
                    −${invoicePreview.creditApplied.toFixed(2)}
                  </span>
                </div>
              )}
              {invoicePreview.prepaidApplied && (
                <div className="py-3 text-ink-secondary border-b border-hairline border-zinc-200" style={{ fontSize: 13 }}>
                  Recorded prepayment already applied to this invoice.
                </div>
              )}
            </>
          ) : (
          <>
          {/* Base appointment service */}
          <button
            type="button"
            onClick={() => onEditServiceLine?.(service)}
            className="w-full flex items-start justify-between gap-3 py-4 bg-white border-b border-hairline border-zinc-200 text-left u-focus-ring"
          >
            <div className="flex-1 min-w-0 pr-2">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-blue-600 truncate" style={{ fontSize: 15 }}>
                  {baseServiceLabel}
                </span>
                <Tag size={14} className="text-zinc-400 shrink-0" strokeWidth={1.5} />
              </div>
              <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>
                {billingSubtitle}
              </div>
              {timeSubtitle && (
                <div className="text-ink-tertiary u-nums" style={{ fontSize: 12, marginTop: 1 }}>
                  {timeSubtitle}
                </div>
              )}
            </div>
            <div className="u-nums text-zinc-900 font-medium shrink-0" style={{ fontSize: 15 }}>
              ${baseServicePrice.toFixed(2)}
            </div>
          </button>

          {splitAppointmentAddons && appointmentAddons.map((addon) => (
            <div
              key={addon.id || addon.serviceId || addon.serviceName}
              className="flex items-start justify-between gap-3 py-4 border-b border-hairline border-zinc-200"
            >
              <div className="flex-1 min-w-0 pr-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-blue-600 truncate" style={{ fontSize: 15 }}>
                    {addon.serviceName || 'Service add-on'}
                  </span>
                  <Tag size={14} className="text-zinc-400 shrink-0" strokeWidth={1.5} />
                </div>
                <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>
                  Included with appointment
                </div>
              </div>
              <div className="u-nums text-zinc-900 font-medium shrink-0" style={{ fontSize: 15 }}>
                ${Number(addon.estimatedPrice || 0).toFixed(2)}
              </div>
            </div>
          ))}

          {/* Extra added services + discounts */}
          {extras.map((e) => {
            const isDiscount = e._kind === 'discount' || e.amount < 0;
            return (
              <div
                key={e.id}
                className="flex items-center justify-between gap-3 py-4 border-b border-hairline border-zinc-200"
              >
                <div className="flex-1 min-w-0 pr-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="font-medium text-blue-600 truncate"
                      style={{ fontSize: 15 }}
                    >
                      {e.description}
                    </span>
                    <Tag size={14} className="text-zinc-400 shrink-0" strokeWidth={1.5} />
                  </div>
                </div>
                <div className="u-nums text-zinc-900 font-medium shrink-0" style={{ fontSize: 15 }}>
                  {isDiscount ? '−' : ''}${Math.abs(extraAmount(e)).toFixed(2)}
                </div>
                <button
                  type="button"
                  onClick={() => removeExtra(e.id)}
                  aria-label={`Remove ${e.description}`}
                  className="flex items-center justify-center h-8 w-8 rounded-full bg-white border border-hairline border-zinc-200 text-zinc-700 u-focus-ring"
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            );
          })}
          </>
          )}
          {prepaidCredit > 0 && (
            <div className="flex items-center justify-between py-4 border-b border-hairline border-zinc-200">
              <span className="font-medium text-zinc-900" style={{ fontSize: 15 }}>
                Prepaid credit
              </span>
              <span className="u-nums text-zinc-900" style={{ fontSize: 15 }}>
                −${prepaidCredit.toFixed(2)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between py-4">
            <span className="text-zinc-900" style={{ fontSize: 15 }}>Total</span>
            <span className="u-nums text-zinc-900" style={{ fontSize: 15 }}>
              ${total.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Add Service / Add Item or Discount. Hidden when an invoice is
            already attached: the mint endpoint reuses that invoice as-is and
            ignores extraLineItems, so offering the pickers would silently
            drop whatever the tech added. */}
        {invoicePreview ? (
          <div className="mt-4 text-ink-secondary" style={{ fontSize: 13 }}>
            {processingVisitInvoice
              ? 'A payment for this invoice is already processing — do not collect again.'
              : <>Charging collects this invoice as-is. To change the amounts, edit{' '}
                {invoicePreview.number ? `invoice ${invoicePreview.number}` : 'the invoice'} from
                the Invoices page before charging.</>}
          </div>
        ) : (
        <div className="mt-4 space-y-3">
          <button
            type="button"
            onClick={() => setShowServicePicker(true)}
            className="w-full bg-white text-zinc-900 font-medium rounded-xs u-focus-ring border border-hairline border-zinc-200"
            style={{ padding: '14px 20px', fontSize: 15 }}
          >
            Add Service
          </button>
          <button
            type="button"
            onClick={() => setShowItemPicker(true)}
            className="w-full bg-white text-zinc-900 font-medium rounded-xs u-focus-ring border border-hairline border-zinc-200"
            style={{ padding: '14px 20px', fontSize: 15 }}
          >
            Add Item or Discount
          </button>
        </div>
        )}
      </div>

      {showServicePicker && (
        <MobileServicePickerSheet
          desktopVisible={desktopVisible}
          customerId={service?.customerId || service?.customer_id || null}
          onClose={() => setShowServicePicker(false)}
          onSelect={handleAddService}
        />
      )}
      {showItemPicker && (
        <MobileItemDiscountPickerSheet
          chosenDiscounts={stackingEnabled ? extras.filter((e) => e._kind === 'discount' && e.discount_id) : []}
          desktopVisible={desktopVisible}
          onClose={() => setShowItemPicker(false)}
          onSelect={handleAddItem}
        />
      )}
    </div>,
    document.body,
  );
}
