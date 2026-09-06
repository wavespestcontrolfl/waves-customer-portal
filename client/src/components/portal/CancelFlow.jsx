import { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';
import { fmtMoney } from '../../lib/money';
import { formatETDateOnly } from '../../lib/timezone';
import { COLORS as B, FONTS } from '../../theme-brand';
import { WAVES_PHONE_DISPLAY } from '../../theme-customer';
import { showCustomerAlert } from '../brand/CustomerDialogHost';

// =========================================================================
// CANCEL FLOW (C1) — the three-screen cancellation inside "Account Options".
//
//   entry → review (Screen 1: scope + before/after facts)
//         → reason (Screen 2: optional reason → resolution preview)
//           → card (one retention card; accept → receipt, decline → confirm)
//         → confirm (Screen 3: facts again, ONE "Cancel {scope}" button)
//         → done (server-reported outcome copy)
//
// Every fact on screen comes from the server's `impact` payload — nothing
// in dollars or dates is computed here. POST /requests/cancel-resolution
// answering 404 means GATE_CANCEL_FLOW_V2 is off: the flow falls back to
// the H0 single-step form ("legacy") so cancelling keeps working dark.
// =========================================================================

// Customer wording for the server reason codes (reason-codes.js). The first
// ten are the chips shown by default; the rest sit behind "More reasons".
const REASONS = [
  { code: 'price', label: 'Price' },
  { code: 'results_pest', label: 'Results (pest)' },
  { code: 'results_lawn', label: 'Results (lawn)' },
  { code: 'service_experience', label: 'Bad experience' },
  { code: 'away', label: 'Away part of the year' },
  { code: 'scheduling_access_communication', label: 'Scheduling or communication' },
  { code: 'moving_or_property_change', label: 'Moving' },
  { code: 'no_longer_needed', label: 'No longer needed' },
  { code: 'service_mix', label: 'Only want some services' },
  { code: 'other', label: 'Other' },
  { code: 'diy', label: 'Doing it myself' },
  { code: 'competitor', label: 'Going with another company' },
  { code: 'hoa_or_landlord', label: 'HOA or landlord' },
  { code: 'financial_hardship', label: 'Financial hardship' },
  { code: 'health_or_chemicals', label: 'Health or chemical concern' },
  { code: 'unexpected_recurring', label: 'Did not expect recurring charges' },
  { code: 'billing_issue', label: 'Billing problem' },
  { code: 'damage_or_adverse_effect', label: 'Damage or adverse effect' },
  { code: 'personal_circumstances', label: 'Personal circumstances' },
];
const PRIMARY_REASON_COUNT = 10;
// Scheduler-canonical values (Codex r1 P1): the accept endpoint 409s
// `preferences_invalid` on anything outside these exact values.
const DAY_OPTIONS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
  .map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }));
const TIME_OPTIONS = [
  { value: 'early_morning', label: '8:00\u201310:00 AM' },
  { value: 'morning', label: '9:00\u201311:00 AM' },
  { value: 'midday', label: '11:00 AM\u20131:00 PM' },
  { value: 'afternoon', label: '1:00\u20135:00 PM' },
];
const HOLD_MAX_DAYS_DEFAULT = 180;

export function reasonLabel(code) {
  return REASONS.find((r) => r.code === code)?.label || null;
}

// Accept-button label per card action type. restart_note / none carry no
// accept action — the card is information only.
export function acceptLabel(action, familyLabel) {
  const family = familyLabel || 'my plan';
  switch (action?.type) {
    case 'retention_offer': return `Keep ${family} with ${action.percentOff ?? 15}% off my next ${action.charges ?? 2} charges`;
    case 'book_reservice': return 'Book the free re-service';
    case 'owner_call': return 'Have our owner call me';
    case 'owner_text': return 'Text our owner';
    case 'away_mode': return 'Switch to exterior-only while I\'m away';
    case 'hold': return `Hold ${family} until I'm back`;
    case 'away_pairing': return 'Away Mode on pest, hold on lawn';
    case 'set_preferences': return 'Update my service days';
    case 'transfer_request': return 'Transfer WaveGuard to my new home';
    case 'configure_services': return 'Keep the services I still want';
    default: return null;
  }
}

const fmtDate = (value) => formatETDateOnly(value, { month: 'short', day: 'numeric', year: 'numeric' });
const listWords = (items) => {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
};
const isoDaysFromNow = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function CancelFlow({ tierName, styles, compact, onOpenRequest, refreshCustomer }) {
  const { muted, subtle, primaryButton, secondaryButton, smallLinkButton } = styles;
  const [stage, setStage] = useState('entry');
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState(null);
  // The whole-account family list from the first preview: the scope picker
  // keeps showing every family even after a partial preview narrows `impact`.
  const [families, setFamilies] = useState([]);
  // Partial scope: the family keys the customer UNchecked. Empty = whole
  // account (the default); families only go to the server when partial.
  const [excluded, setExcluded] = useState([]);
  const [reason, setReason] = useState('');
  const [moreReasons, setMoreReasons] = useState(false);
  const [details, setDetails] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [adverseEvent, setAdverseEvent] = useState(false);
  const [safetyComplaint, setSafetyComplaint] = useState(false);
  const [preview, setPreview] = useState(null);
  const [cardExpanded, setCardExpanded] = useState(false);
  const [declinedViaCard, setDeclinedViaCard] = useState(false);
  const [resumeDate, setResumeDate] = useState('');
  const [preferredDay, setPreferredDay] = useState('');
  const [preferredTime, setPreferredTime] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [outcome, setOutcome] = useState(null);
  // H0 fallback state (gate off).
  const [legacyReason, setLegacyReason] = useState('');
  const headingRef = useRef(null);

  useEffect(() => {
    if (['review', 'reason', 'card', 'confirm', 'receipt', 'done'].includes(stage)) headingRef.current?.focus?.();
  }, [stage]);

  const partial = excluded.length > 0 && excluded.length < families.length;
  const selectedFamilies = partial ? families.filter((f) => !excluded.includes(f.key)).map((f) => f.key) : undefined;
  const selectedLabels = families.filter((f) => !selectedFamilies || selectedFamilies.includes(f.key)).map((f) => f.label);
  const scopeLabel = partial ? listWords(selectedLabels) : 'my plan';
  // Codex r1 P2: the server flags plans it cannot price partially online.
  const partialUnsupported = partial && impact?.scopedSupported === false;
  const subject = partial
    ? `Cancel ${listWords(selectedLabels)} (WaveGuard ${tierName})`
    : `Cancel WaveGuard ${tierName} plan`;

  const previewBody = (withReason) => ({
    ...(selectedFamilies ? { families: selectedFamilies } : {}),
    ...(withReason && reason ? { reason } : {}),
    ...(withReason && reason === 'moving_or_property_change' && newAddress.trim() ? { new_address: newAddress.trim() } : {}),
    ...(withReason && reason === 'health_or_chemicals' && adverseEvent ? { adverse_event: true } : {}),
    ...(withReason && reason === 'service_experience' && safetyComplaint ? { safety_complaint: true } : {}),
  });

  const loadImpact = async (nextExcluded = excluded) => {
    const keys = families.filter((f) => !nextExcluded.includes(f.key)).map((f) => f.key);
    const isPartial = nextExcluded.length > 0 && nextExcluded.length < families.length;
    const res = await api.cancelResolutionPreview(isPartial ? { families: keys } : {});
    if (res?.impact) setImpact(res.impact);
  };

  const start = async () => {
    setBusy(true);
    try {
      const res = await api.cancelResolutionPreview({});
      setImpact(res?.impact || null);
      setFamilies(Array.isArray(res?.impact?.families) ? res.impact.families : []);
      setStage('review');
    } catch (err) {
      if (err?.status === 404) { setStage('legacy'); return; }
      showCustomerAlert(`Couldn't load your plan details: ${err.message || `please try again or call us at ${WAVES_PHONE_DISPLAY}.`}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleFamily = async (key) => {
    const next = excluded.includes(key) ? excluded.filter((k) => k !== key) : [...excluded, key];
    // Unchecking everything is "whole account" again, not "nothing".
    const normalized = next.length >= families.length ? [] : next;
    setExcluded(normalized);
    try { await loadImpact(normalized); } catch { /* keep the last facts on screen */ }
  };

  const continueFromReason = async () => {
    setDeclinedViaCard(false);
    setCardExpanded(false);
    if (!reason) { setPreview(null); setStage('confirm'); return; }
    setBusy(true);
    try {
      const res = await api.cancelResolutionPreview(previewBody(true));
      if (res?.impact) setImpact(res.impact);
      setPreview(res || null);
      setStage(res?.kind === 'card' && res.card ? 'card' : 'confirm');
    } catch (err) {
      if (err?.status === 404) { setPreview(null); setStage('confirm'); return; }
      showCustomerAlert(`Couldn't check your options: ${err.message || `please try again or call us at ${WAVES_PHONE_DISPLAY}.`}`);
    } finally {
      setBusy(false);
    }
  };

  const acceptCard = async () => {
    const action = preview?.card?.action;
    const needsDate = action?.type === 'hold' || action?.type === 'away_pairing';
    if (needsDate && !/^\d{4}-\d{2}-\d{2}$/.test(resumeDate)) {
      showCustomerAlert('Pick the date you would like service to resume.');
      return;
    }
    if (action?.type === 'transfer_request' && !newAddress.trim()) {
      showCustomerAlert('Enter the address you are moving to so we can transfer your plan.');
      return;
    }
    if (action?.type === 'set_preferences' && !preferredDay && !preferredTime) {
      showCustomerAlert('Pick the day or time window that works better.');
      return;
    }
    let params;
    if (needsDate) params = { resumeDate };
    else if (action?.type === 'transfer_request') params = { newAddress: newAddress.trim() };
    else if (action?.type === 'set_preferences') {
      params = {
        ...(preferredDay ? { preferredDay } : {}),
        ...(preferredTime ? { preferredTime } : {}),
      };
    }
    setBusy(true);
    try {
      const res = await api.cancelResolutionAccept({
        reasonCode: preview.reasonCode || reason,
        families: selectedFamilies || [],
        templateId: preview.card.templateId,
        ...(params ? { params } : {}),
      });
      setReceipt(res?.receipt || null);
      setStage('receipt');
    } catch (err) {
      if (err?.code === 'resolution_stale') {
        // The card no longer matches the account (e.g. changed in another
        // tab) — re-run the preview rather than acting on stale facts.
        showCustomerAlert('That option is no longer current — we refreshed your choices.');
        setPreview(null); setCardExpanded(false); setStage('reason');
        return;
      }
      showCustomerAlert(`Couldn't set that up: ${err.message || `please try again or call us at ${WAVES_PHONE_DISPLAY}.`}`);
    } finally {
      setBusy(false);
    }
  };

  const submitCancel = async (payload) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.createRequest?.(payload);
      const c = result?.cancellation || {};
      const label = (item) => {
        if (item && typeof item === 'object') return item.label || String(item.key || '');
        return families.find((f) => f.key === item)?.label || String(item || '');
      };
      setOutcome({
        processed: c.processed === true,
        confirmation: ['sms', 'email'].includes(c.confirmation) ? c.confirmation : null,
        channels: Array.isArray(c.confirmationChannels) ? c.confirmationChannels.filter((ch) => ['sms', 'email'].includes(ch)) : [],
        effectiveDate: /^\d{4}-\d{2}-\d{2}$/.test(c.effectiveDate || '') ? c.effectiveDate : null,
        scope: Array.isArray(c.scope) ? c.scope.map(label).filter(Boolean) : [],
        remaining: Array.isArray(c.remaining) ? c.remaining.map(label).filter(Boolean) : [],
        tierAfter: c.tierAfter || null,
      });
      setStage('done');
      // A processed WHOLE-ACCOUNT cancellation has already made the account
      // inactive server-side — without refreshing the auth snapshot the
      // shell keeps rendering the live-plan UI and Billing's active-state
      // loader hits now-blocked routes (codex GH r14 P1). Awaited so the
      // cancelled banner, narrowed tabs, and restart panel appear
      // immediately; a scoped cancellation leaves the account active, so
      // nothing to refresh there. Keyed on the server's CHURNED flag, not
      // `processed` (codex GH r28 P1): the churn write runs first, so a
      // whole-account cancel whose later sweep step parked for office
      // review reports churned:true with processed:false — the account is
      // already inactive and the live-plan UI would 401 on its loaders.
      if ((c.churned === true || c.processed === true) && !(Array.isArray(c.remaining) && c.remaining.length)) {
        try { await refreshCustomer?.(); } catch { /* stale until reload; the server state is already correct */ }
      }
    } catch (err) {
      showCustomerAlert(`Couldn't submit cancellation request: ${err.message || `please try again or call us at ${WAVES_PHONE_DISPLAY}.`}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmCancel = () => submitCancel({
    category: 'cancellation',
    subject,
    description: `Customer requested cancellation of ${scopeLabel}. Reason: ${reasonLabel(reason) || 'Not specified'}. Details: ${details.trim() || 'None'}`,
    ...(reason ? { reasonCode: reason } : {}),
    ...(selectedFamilies ? { families: selectedFamilies } : {}),
    ...(preview?.card?.templateId ? { resolutionTemplateId: preview.card.templateId, resolutionOutcome: declinedViaCard ? 'declined' : 'shown' } : {}),
    ...(reason === 'moving_or_property_change' && newAddress.trim() ? { newAddress: newAddress.trim() } : {}),
    ...(reason === 'health_or_chemicals' && adverseEvent ? { adverseEvent: true } : {}),
    ...(reason === 'service_experience' && safetyComplaint ? { safetyComplaint: true } : {}),
  });

  const reset = () => {
    setStage('entry');
    setExcluded([]); setReason(''); setMoreReasons(false); setDetails(''); setNewAddress('');
    setAdverseEvent(false); setSafetyComplaint(false); setPreview(null); setCardExpanded(false);
    setDeclinedViaCard(false); setResumeDate(''); setPreferredDay(''); setPreferredTime(''); setReceipt(null);
  };

  // ---- shared bits -------------------------------------------------------
  // Both buttons of every pair share this exact box so neither reads as the
  // "real" one — the cancel action is never smaller than the alternative.
  const pairBox = { minHeight: 44, fontSize: 16, flex: '1 1 0', minWidth: 0, justifyContent: 'center', textAlign: 'center' };
  const pairRow = { display: 'flex', gap: 8, flexDirection: compact ? 'column' : 'row', marginTop: 16 };
  const pairPrimary = { ...primaryButton, ...pairBox, opacity: busy ? 0.65 : 1, cursor: busy ? 'wait' : 'pointer' };
  const pairSecondary = { ...secondaryButton, ...pairBox };
  const pairCancel = { ...pairPrimary, background: B.grayMid };
  const heading = { margin: 0, fontSize: 15, color: B.glassNavy, fontWeight: 700, outline: 'none' };
  const body = { fontSize: 14, color: muted, marginTop: 4, lineHeight: 1.45 };
  const backLink = { ...smallLinkButton, fontSize: 14, padding: '6px 0', marginLeft: 0 };
  const chip = (active) => ({
    padding: '13px 16px', borderRadius: 999, fontSize: 14, fontWeight: 700,
    border: `1px solid ${active ? B.red : '#D8D0C0'}`,
    background: active ? `${B.red}10` : '#fff',
    color: active ? B.red : B.grayDark,
    cursor: 'pointer', fontFamily: FONTS.body,
  });
  const field = {
    width: '100%', marginTop: 10, padding: '12px 14px', borderRadius: 8, fontSize: 16,
    border: '1px solid #D8D0C0', fontFamily: FONTS.body, boxSizing: 'border-box',
  };
  const checkRow = { display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 10, fontSize: 14, color: B.grayDark, lineHeight: 1.45, cursor: 'pointer' };
  const backButton = (to) => (
    <button type="button" onClick={() => setStage(to)} className="waves-focus-ring" style={backLink}>Back</button>
  );

  // ---- before/after facts (server `impact` only) ---------------------------
  const factRows = (dense) => {
    if (!impact) return null;
    const remaining = Array.isArray(impact.remaining) ? impact.remaining : [];
    const remainingLabels = remaining.map((r) => r.label);
    const perMonth = impact.billingMode === 'monthly' ? '/mo' : '';
    const arrow = (before, after) => `${before} → ${after}`;
    const rows = [];
    if (families.length) rows.push(['Active services', arrow(listWords(families.map((f) => f.label)), remainingLabels.length ? listWords(remainingLabels) : 'None')]);
    if (impact.tierBefore != null) {
      const tierText = (t, d) => (t ? `WaveGuard ${t}${typeof d === 'number' && d > 0 ? ` (${d}% off)` : ''}` : 'No plan');
      rows.push(['WaveGuard level', arrow(tierText(impact.tierBefore, impact.tierDiscountBefore), tierText(impact.tierAfter, impact.tierDiscountAfter))]);
    }
    if (impact.accountMonthlyBefore != null) rows.push(['Account total per month', arrow(fmtMoney(impact.accountMonthlyBefore), impact.accountMonthlyAfter != null ? fmtMoney(impact.accountMonthlyAfter) : '—')]);
    for (const r of remaining) {
      if (r.monthlyBefore != null || r.monthlyAfter != null) rows.push([`${r.label} rate${perMonth}`, arrow(fmtMoney(r.monthlyBefore), fmtMoney(r.monthlyAfter))]);
    }
    if (impact.nextCharge?.amount != null) rows.push(['Next charge', `${fmtMoney(impact.nextCharge.amount)}${impact.nextCharge.date ? ` on ${fmtDate(impact.nextCharge.date)}` : ''}`]);
    if (impact.visitsCancelled != null) rows.push(['Visits cancelled', `${impact.visitsCancelled}${impact.nextVisitCancelled ? ` (next: ${fmtDate(impact.nextVisitCancelled)})` : ''}`]);
    if (Number(impact.lateCancelFee) > 0) rows.push(['Scheduled-visit fee', `${fmtMoney(impact.lateCancelFee)} (a visit already inside its late-cancellation window)`]);
    if (Number(impact.openBalance) > 0) rows.push(['Outstanding balance', fmtMoney(impact.openBalance), impact.payUrl ? { href: impact.payUrl, label: 'Pay now' } : null]);
    if (impact.prepay) {
      const p = impact.prepay;
      rows.push(['Prepaid remainder', [p.covered ? 'Covered' : null, p.endsAt ? `through ${fmtDate(p.endsAt)}` : null, p.visitsRemaining != null ? `${p.visitsRemaining} visits remaining` : null].filter(Boolean).join(', ') || 'On file']);
    }
    if (impact.effectiveDate) rows.push(['Effective date', fmtDate(impact.effectiveDate)]);
    if (impact.autopayOn) rows.push(['AutoPay', partial && remainingLabels.length ? `Remains active for ${listWords(remainingLabels)}` : 'Turns off']);
    if (impact.termiteRental) rows.push(['Termite bait stations', 'Retrieved after cancellation']);
    return (
      <dl style={{ margin: dense ? '10px 0 0' : '14px 0 0', display: 'grid', gap: dense ? 6 : 8, background: subtle, borderRadius: 8, padding: dense ? '10px 12px' : '12px 14px' }}>
        {rows.map(([label, value, link]) => (
          <div key={label} style={{ display: 'grid', gridTemplateColumns: compact ? '1fr' : '160px 1fr', gap: compact ? 2 : 10, fontSize: 14, lineHeight: 1.4 }}>
            <dt style={{ margin: 0, color: muted, fontWeight: 700 }}>{label}</dt>
            <dd style={{ margin: 0, color: B.grayDark }}>
              {value}
              {link && <> · <a href={link.href} target="_blank" rel="noopener noreferrer" className="waves-focus-ring" style={{ color: B.glassNavy, fontWeight: 700 }}>{link.label}</a></>}
            </dd>
          </div>
        ))}
      </dl>
    );
  };

  // ---- outcome copy (shared by the v2 flow and the H0 fallback) ------------
  const outcomeCopy = () => {
    if (!outcome) return null;
    const channels = outcome.channels;
    // Partial cancel confirmed by the server: name what stopped and what
    // continues, from the commit response itself.
    const scoped = outcome.scope.length > 0 && outcome.remaining.length > 0;
    const confirmationLine = channels.includes('sms') && channels.includes('email')
      ? ' A confirmation text and email are on the way.'
      : outcome.confirmation === 'sms' ? ' A confirmation text is on its way.'
        : outcome.confirmation === 'email' ? ' A confirmation email is on its way.'
          : ' Keep this screen as your confirmation.';
    return (
      <div role="status" style={{ marginTop: 12, color: B.grayDark, fontSize: 14, fontWeight: 700, lineHeight: 1.5 }}>
        {outcome.processed
          ? `${scoped ? `${listWords(outcome.scope)} cancelled; ${listWords(outcome.remaining)} continue${outcome.tierAfter ? ` under WaveGuard ${outcome.tierAfter}` : ''}` : `Your plan is cancelled${outcome.effectiveDate ? ` as of ${fmtDate(outcome.effectiveDate)}` : ''}`}. ${scoped ? 'The cancelled visits are off the calendar.' : 'Upcoming visits are off the calendar and autopay is off.'} Nothing more is charged for ${scoped ? 'the cancelled services' : 'future service'}; a visit already inside its late-cancellation window keeps its scheduled-visit fee.${confirmationLine} Changed your mind? Call ${WAVES_PHONE_DISPLAY} and we will put it back.`
          : 'We received your cancellation and are closing out your plan by hand. You will hear from us within 1 business day to confirm exactly what has stopped.'}
      </div>
    );
  };

  // ---- screens -------------------------------------------------------------
  if (stage === 'done') return outcomeCopy();

  if (stage === 'entry' || stage === 'loading') {
    return (
      <>
        <div style={{ marginTop: 4, fontSize: 14, color: muted, lineHeight: 1.45 }}>Cancel your plan any time.</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
          <button type="button" onClick={start} disabled={busy} className="waves-focus-ring" style={smallLinkButton}>{busy ? 'Loading…' : 'Cancel'}</button>
        </div>
      </>
    );
  }

  if (stage === 'legacy') {
    // H0 single-step form — GATE_CANCEL_FLOW_V2 is off on the server.
    return (
      <div style={{ marginTop: 14 }}>
        <h3 ref={headingRef} tabIndex={-1} style={heading}>Cancel My Plan</h3>
        <div style={body}>
          This takes effect right away: upcoming visits come off the calendar and autopay turns off. There is no cancellation fee; charges for visits already completed stay payable, and a visit already inside its late-cancellation window keeps the scheduled-visit fee from your booking.
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {['Moving', 'Cost', 'Not satisfied', 'Switching providers', 'Other'].map((r) => (
            <button key={r} type="button" onClick={() => setLegacyReason(r)} className="waves-focus-ring" aria-pressed={legacyReason === r} style={chip(legacyReason === r)}>{r}</button>
          ))}
        </div>
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything else you'd like us to know?" aria-label="Cancellation details" rows={3} className="waves-focus-ring" style={{ ...field, resize: 'vertical' }} />
        <div style={pairRow}>
          <button data-glass-accent="" type="button" onClick={reset} className="waves-focus-ring" style={pairSecondary}>Keep My Plan</button>
          <button type="button" disabled={busy} className="waves-focus-ring" style={pairCancel} onClick={() => submitCancel({
            category: 'cancellation',
            subject: `Cancel WaveGuard ${tierName} plan`,
            description: `Customer requested cancellation. Reason: ${legacyReason || 'Not specified'}. Details: ${details.trim() || 'None'}`,
          })}>{busy ? 'Cancelling...' : 'Cancel My Plan'}</button>
        </div>
      </div>
    );
  }

  if (stage === 'review') {
    return (
      <div style={{ marginTop: 14 }}>
        <h3 ref={headingRef} tabIndex={-1} style={heading}>Review cancelling {scopeLabel}</h3>
        <div style={body}>Here is exactly what changes. Nothing happens until you confirm on the last step.</div>
        {families.length > 1 && (
          <fieldset style={{ border: 'none', margin: '12px 0 0', padding: 0 }}>
            <legend style={{ fontSize: 14, fontWeight: 700, color: B.glassNavy, padding: 0 }}>What to cancel</legend>
            <div style={{ fontSize: 14, color: muted, marginTop: 2 }}>Uncheck any service you want to keep.</div>
            {families.map((f) => (
              <label key={f.key} style={checkRow}>
                <input type="checkbox" checked={!excluded.includes(f.key)} onChange={() => toggleFamily(f.key)} className="waves-focus-ring" style={{ width: 18, height: 18, marginTop: 1 }} />
                <span>
                  {f.label}
                  {f.upcomingVisits != null && <span style={{ color: muted }}> · {f.upcomingVisits} upcoming visit{f.upcomingVisits === 1 ? '' : 's'}{f.nextVisitDate ? `, next ${fmtDate(f.nextVisitDate)}` : ''}</span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {factRows(false)}
        {partialUnsupported && (
          <div style={{ ...body, marginTop: 10 }}>
            We can't price a partial cancellation for this plan online — pick the whole plan, or call our office and we'll cancel just that service by hand.
          </div>
        )}
        <div style={pairRow}>
          <button data-glass-accent="" type="button" onClick={reset} className="waves-focus-ring" style={pairSecondary}>Keep my plan</button>
          <button type="button" disabled={partialUnsupported} onClick={() => setStage('reason')} className="waves-focus-ring" style={{ ...pairPrimary, ...(partialUnsupported ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}>Continue</button>
        </div>
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => onOpenRequest?.()} className="waves-focus-ring" style={backLink}>Need to move, reschedule or report a problem instead?</button>
        </div>
      </div>
    );
  }

  if (stage === 'reason') {
    const visible = moreReasons ? REASONS : REASONS.slice(0, PRIMARY_REASON_COUNT);
    return (
      <div style={{ marginTop: 14 }}>
        {backButton('review')}
        <h3 ref={headingRef} tabIndex={-1} style={heading}>What's driving this change?</h3>
        <div style={body}>Optional. It helps us do better, and it may turn up an option that fits.</div>
        <div role="group" aria-label="Reason" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
          {visible.map((r) => (
            <button key={r.code} type="button" onClick={() => setReason(reason === r.code ? '' : r.code)} className="waves-focus-ring" aria-pressed={reason === r.code} style={chip(reason === r.code)}>{r.label}</button>
          ))}
        </div>
        {!moreReasons && (
          <button type="button" onClick={() => setMoreReasons(true)} className="waves-focus-ring" aria-expanded={false} style={{ ...backLink, marginTop: 6 }}>More reasons</button>
        )}
        {reason === 'moving_or_property_change' && (
          <input type="text" value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="New address (optional)" aria-label="New address" autoComplete="street-address" className="waves-focus-ring" style={field} />
        )}
        {reason === 'health_or_chemicals' && (
          <label style={checkRow}>
            <input type="checkbox" checked={adverseEvent} onChange={(e) => setAdverseEvent(e.target.checked)} className="waves-focus-ring" style={{ width: 18, height: 18, marginTop: 1 }} />
            <span>This was a health or pet reaction to a treatment</span>
          </label>
        )}
        {reason === 'service_experience' && (
          <label style={checkRow}>
            <input type="checkbox" checked={safetyComplaint} onChange={(e) => setSafetyComplaint(e.target.checked)} className="waves-focus-ring" style={{ width: 18, height: 18, marginTop: 1 }} />
            <span>This involved conduct, entry or safety</span>
          </label>
        )}
        <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything else you'd like us to know? (optional)" aria-label="Cancellation details" rows={3} className="waves-focus-ring" style={{ ...field, resize: 'vertical' }} />
        <div style={pairRow}>
          <button data-glass-accent="" type="button" onClick={reset} className="waves-focus-ring" style={pairSecondary}>Keep my plan</button>
          <button type="button" disabled={busy} onClick={continueFromReason} className="waves-focus-ring" style={pairPrimary}>{busy ? 'Checking…' : 'Continue'}</button>
        </div>
      </div>
    );
  }

  if (stage === 'card') {
    const card = preview.card;
    const action = card.action || {};
    const familyName = action.family || card.family || (selectedFamilies?.length === 1 ? selectedLabels[0] : null);
    const label = acceptLabel(action, familyName);
    const needsDate = action.type === 'hold' || action.type === 'away_pairing';
    const declineToConfirm = () => { setDeclinedViaCard(true); setStage('confirm'); };
    return (
      <div style={{ marginTop: 14 }}>
        {backButton('reason')}
        {!cardExpanded ? (
          <>
            <h3 ref={headingRef} tabIndex={-1} style={heading}>One option may fit better</h3>
            <div style={body}>Based on what you told us, there is one thing worth a look before you go. Your cancellation is still one step away either way.</div>
            <div style={pairRow}>
              <button type="button" onClick={() => setCardExpanded(true)} className="waves-focus-ring" style={pairPrimary}>Show me</button>
              <button type="button" onClick={declineToConfirm} className="waves-focus-ring" style={pairCancel}>Continue with cancellation</button>
            </div>
          </>
        ) : (
          <>
            <h3 ref={headingRef} tabIndex={-1} style={heading}>{card.headline}</h3>
            <div style={body}>{card.body}</div>
            {card.changes && <div style={{ ...body, marginTop: 8, fontWeight: 700, color: B.grayDark }}>{card.changes}</div>}
            {needsDate && (
              <label style={{ display: 'block', marginTop: 10, fontSize: 14, color: B.grayDark }}>
                Resume service on
                <input type="date" value={resumeDate} min={isoDaysFromNow(1)} max={isoDaysFromNow(action.holdMaxDays || HOLD_MAX_DAYS_DEFAULT)} onChange={(e) => setResumeDate(e.target.value)} className="waves-focus-ring" style={{ ...field, marginTop: 6 }} />
              </label>
            )}
            {action.type === 'transfer_request' && (
              <label style={{ display: 'block', marginTop: 10, fontSize: 14, color: B.grayDark }}>
                New address
                <input type="text" value={newAddress} onChange={(e) => setNewAddress(e.target.value)} autoComplete="street-address" className="waves-focus-ring" style={{ ...field, marginTop: 6 }} />
              </label>
            )}
            {action.type === 'set_preferences' && (
              <div style={{ display: 'flex', gap: 8, flexDirection: compact ? 'column' : 'row' }}>
                <label style={{ display: 'block', marginTop: 10, fontSize: 14, color: B.grayDark, flex: '1 1 0' }}>
                  Preferred day
                  <select value={preferredDay} onChange={(e) => setPreferredDay(e.target.value)} className="waves-focus-ring" style={{ ...field, marginTop: 6 }}>
                    <option value="">No preference</option>
                    {DAY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label style={{ display: 'block', marginTop: 10, fontSize: 14, color: B.grayDark, flex: '1 1 0' }}>
                  Preferred time
                  <select value={preferredTime} onChange={(e) => setPreferredTime(e.target.value)} className="waves-focus-ring" style={{ ...field, marginTop: 6 }}>
                    <option value="">No preference</option>
                    {TIME_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
              </div>
            )}
            <div style={pairRow}>
              {label
                ? <button type="button" disabled={busy} onClick={acceptCard} className="waves-focus-ring" style={pairPrimary}>{busy ? 'Setting up…' : label}</button>
                : <button data-glass-accent="" type="button" onClick={reset} className="waves-focus-ring" style={pairSecondary}>Keep my plan</button>}
              <button type="button" onClick={declineToConfirm} className="waves-focus-ring" style={pairCancel}>Complete my cancellation</button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (stage === 'receipt') {
    const channels = Array.isArray(receipt?.confirmationChannels) ? receipt.confirmationChannels : [];
    const effects = Array.isArray(receipt?.effects) ? receipt.effects : [];
    return (
      <div style={{ marginTop: 14 }}>
        <h3 ref={headingRef} tabIndex={-1} style={heading}>All set</h3>
        {receipt?.summary && <div style={body}>{receipt.summary}</div>}
        {effects.length > 0 && (
          <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 14, color: B.grayDark, lineHeight: 1.5 }}>
            {effects.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}
        {receipt?.reserviceUrl && (
          <div style={{ marginTop: 10 }}>
            <a href={receipt.reserviceUrl} className="waves-focus-ring" style={{ fontSize: 14, fontWeight: 700, color: B.glassNavy }}>Pick your re-service time</a>
          </div>
        )}
        <div style={{ ...body, marginTop: 10 }}>
          {receipt?.reference && <>Reference {receipt.reference}. </>}
          {channels.includes('sms') && channels.includes('email') ? 'A confirmation text and email are on the way.'
            : channels.includes('sms') ? 'A confirmation text is on its way.'
              : channels.includes('email') ? 'A confirmation email is on its way.'
                : 'Keep this screen as your confirmation.'}
          {' '}Your plan stays exactly as it is otherwise.
        </div>
        <div style={pairRow}>
          <button data-glass-accent="" type="button" onClick={reset} className="waves-focus-ring" style={{ ...pairPrimary, flex: compact ? undefined : '0 0 auto' }}>Back to my plan</button>
        </div>
      </div>
    );
  }

  if (stage === 'confirm') {
    const cancelLabel = partial ? `Cancel ${listWords(selectedLabels)}` : 'Cancel my plan';
    return (
      <div style={{ marginTop: 14 }}>
        {backButton(preview?.kind === 'card' ? 'card' : 'reason')}
        <h3 ref={headingRef} tabIndex={-1} style={heading}>Confirm cancelling {scopeLabel}</h3>
        <div style={body}>This takes effect right away. There is no cancellation fee; charges for visits already completed stay payable.</div>
        {preview?.kind === 'hard_stop' && (
          <div style={{ ...body, marginTop: 8 }}>We'll review this on our side; your cancellation still completes.</div>
        )}
        {factRows(true)}
        <div style={pairRow}>
          <button data-glass-accent="" type="button" onClick={reset} className="waves-focus-ring" style={pairSecondary}>Keep my plan</button>
          <button type="button" disabled={busy} onClick={confirmCancel} className="waves-focus-ring" style={pairCancel}>{busy ? 'Cancelling...' : cancelLabel}</button>
        </div>
      </div>
    );
  }

  return null;
}
