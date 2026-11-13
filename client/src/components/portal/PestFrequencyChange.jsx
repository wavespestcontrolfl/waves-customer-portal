// client/src/components/portal/PestFrequencyChange.jsx
// "Change how often we visit" on My Plan (pest control visit frequency; the
// server side is gated by GATE_PEST_FREQUENCY_CHANGE). The entry renders only
// when GET /api/pest-frequency answers { available: true }; any failure, a
// missing route or any other body renders nothing and logs nothing.
//
// The sheet has three steps: choose a plan with more visits, review the new
// schedule (a preview that writes nothing), then confirm. Fewer visits is
// never a one-tap change: it is a message to the office through the portal
// Messages thread, sent only when the customer taps "Send message".
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../utils/api';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useModalFocus from '../../hooks/useModalFocus';
import useIsMobile from '../../hooks/useIsMobile';
import { fmtMoney } from '../../lib/money';
import { formatETDateOnly } from '../../lib/timezone';
import { COLORS as B, FONTS } from '../../theme-brand';
import { WAVES_SUPPORT_PHONE_DISPLAY } from '../../constants/business';
import { makeRequestId } from './PortalMessages';

const CADENCE = {
  quarterly: 'every three months',
  bimonthly: 'every two months',
  monthly: 'every month',
};
const OPTION_HEADING = {
  bimonthly: 'Every two months',
  monthly: 'Every month',
};
const FEWER_VISITS_SENTENCE = "I'd like fewer pest control visits.";
const GENERIC_ERROR = 'Something went wrong — please try again.';
const UNAVAILABLE_SENTENCE = "We can't make this change online for your plan.";

const cadenceOf = (frequency) => CADENCE[frequency] || 'on a new schedule';
const dayLabel = (date) => formatETDateOnly(date, { month: 'short', day: 'numeric', year: 'numeric' }) || String(date || '');
const dayList = (dates) => dates.map(dayLabel).join(', ');

// Whether the server offers the change. `enabled` false (a cancelled account)
// never asks. Returns { data, reload }: data is the available payload or null.
export function usePestFrequency(enabled) {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) { setData(null); return undefined; }
    let live = true;
    // Inside the promise chain, so a missing method also just hides the entry.
    Promise.resolve().then(() => api.getPestFrequency())
      .then((d) => { if (live) setData(d?.available === true ? d : null); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [enabled, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, reload };
}

// The "send this to the office" action. Nothing is sent until the customer
// taps "Send message". One request id per sentence, kept across retries, so a
// retry never saves the message twice.
function OfficeMessage({ sentence, linkLabel, ui }) {
  const [state, setState] = useState('idle'); // idle | ask | sending | sent | failed
  const requestRef = useRef(null);
  const muted = ui.shell.muted;
  const linkStyle = {
    background: 'none', border: 'none', padding: '8px 0', minHeight: 44, color: B.glassNavy,
    fontWeight: 700, fontSize: 14, fontFamily: FONTS.body, cursor: 'pointer', textDecoration: 'underline', textAlign: 'left',
  };
  const send = async () => {
    if (state === 'sending') return;
    setState('sending');
    try {
      if (requestRef.current?.text !== sentence) requestRef.current = { id: makeRequestId(), text: sentence };
      await api.sendPortalMessage(sentence, requestRef.current.id);
      setState('sent');
    } catch {
      setState('failed');
    }
  };
  if (state === 'sent') {
    return <div role="status" style={{ fontSize: 14, color: ui.shell.text, lineHeight: 1.5 }}>Sent. We&apos;ll answer in Messages.</div>;
  }
  if (state === 'idle') {
    return <button type="button" style={linkStyle} onClick={() => setState('ask')}>{linkLabel}</button>;
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontSize: 14, color: muted, lineHeight: 1.5 }}>
        We&apos;ll send this to the office: &quot;{sentence}&quot;
      </div>
      {state === 'failed' && <div role="alert" style={{ fontSize: 14, color: '#9A3412' }}>{GENERIC_ERROR}</div>}
      <button
        type="button"
        data-glass-accent=""
        style={{ ...ui.secondaryAction, opacity: state === 'sending' ? 0.55 : 1 }}
        disabled={state === 'sending'}
        onClick={send}
      >
        {state === 'sending' ? 'Sending…' : 'Send message'}
      </button>
    </div>
  );
}

// ui = the My Plan shell tokens PortalPage owns: { shell, subtle, primaryAction,
// secondaryAction, CloseButton, IconTile }. Passed in (as MovingEntry takes its
// styles) because PortalPage.jsx does not export them.
function PestFrequencyOverlay({ data, ui, messagesEnabled, onClose, onChanged }) {
  useLockBodyScroll(true);
  const compact = useIsMobile(760);
  const { shell, CloseButton, IconTile } = ui;
  const muted = shell.muted;

  const [step, setStep] = useState('choose'); // choose | review | done
  const [chosen, setChosen] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null); // null | { kind: 'unavailable' | 'changed' | 'text', text }
  const confirmingRef = useRef(false);
  const previewSeq = useRef(0);

  const closeOverlay = () => {
    if (confirmingRef.current) return;
    onClose();
    if (step === 'done') onChanged();
  };
  const dialogRef = useModalFocus(true, closeOverlay);

  const failWith = (err) => {
    if (err?.code === 'FREQUENCY_CHANGE_UNAVAILABLE') return { kind: 'unavailable' };
    if (err?.status === 429 && err.message) return { kind: 'text', text: err.message };
    return { kind: 'text', text: GENERIC_ERROR };
  };

  const runPreview = async (frequency, { changed = false } = {}) => {
    const seq = ++previewSeq.current;
    setChosen(frequency);
    setPreviewing(true);
    setError(null);
    if (!changed) { setPreview(null); setStep('review'); }
    try {
      const p = await api.previewPestFrequency({ frequency });
      if (seq !== previewSeq.current) return;
      setPreview(p);
      setStep('review');
      if (changed) setError({ kind: 'changed', text: 'Your schedule changed — please review the new dates.' });
    } catch (err) {
      if (seq !== previewSeq.current) return;
      setError(failWith(err));
      setPreview(null);
      setStep('choose');
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  };

  const confirm = async () => {
    if (!preview || confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    setError(null);
    try {
      const res = await api.confirmPestFrequency({ frequency: chosen, version: preview.version });
      setResult({ ...preview, ...(res || {}) });
      setStep('done');
    } catch (err) {
      if (err?.code === 'PREVIEW_CHANGED') {
        confirmingRef.current = false;
        setConfirming(false);
        await runPreview(chosen, { changed: true });
        return;
      }
      setError(failWith(err));
      if (err?.code === 'FREQUENCY_CHANGE_UNAVAILABLE') setStep('choose');
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  const back = () => {
    if (confirmingRef.current) return;
    previewSeq.current += 1;
    setPreviewing(false);
    setPreview(null);
    setError(null);
    setStep('choose');
  };

  const softBox = {
    padding: '12px 14px',
    borderRadius: 10,
    background: ui.subtle,
    border: `1px solid ${shell.border}`,
  };
  const heading = { fontSize: 16, fontWeight: 700, color: B.glassNavy };
  const line = { fontSize: 14, color: muted, lineHeight: 1.5 };
  const current = data.current || {};
  const options = Array.isArray(data.options) ? data.options : [];

  const unavailableBlock = (
    <div role="alert" style={softBox}>
      {messagesEnabled ? (
        <>
          <div style={{ ...line, color: shell.text }}>
            {UNAVAILABLE_SENTENCE} Send us a message and we&apos;ll take care of it.
          </div>
          <div style={{ marginTop: 6 }}>
            <OfficeMessage
              sentence={`I'd like pest control visits ${cadenceOf(chosen)}.`}
              linkLabel="Send us a message"
              ui={ui}
            />
          </div>
        </>
      ) : (
        <div style={{ ...line, color: shell.text }}>
          {UNAVAILABLE_SENTENCE} Call us at {WAVES_SUPPORT_PHONE_DISPLAY}.
        </div>
      )}
    </div>
  );
  const errorBlock = error?.kind === 'unavailable'
    ? unavailableBlock
    : error ? <div role="alert" style={{ fontSize: 14, color: '#9A3412', lineHeight: 1.5 }}>{error.text}</div> : null;

  const title = step === 'review' ? 'Review your new plan' : step === 'done' ? 'Your plan is changed' : 'How often should we visit?';
  const nextVisit = result?.keptVisit?.date || result?.newVisits?.[0] || '';

  let body;
  if (step === 'choose') {
    body = (
      <>
        <div style={line}>
          Today: {cadenceOf(current.frequency)} &middot; {fmtMoney(current.perVisit)} a visit &middot; {fmtMoney(current.perYear)} a year
        </div>
        {errorBlock}
        {options.length === 0 ? (
          <div style={{ ...softBox, fontSize: 15, color: shell.text }}>You&apos;re on our most frequent pest plan.</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {options.map((opt) => (
              <button
                key={opt.frequency}
                type="button"
                disabled={previewing}
                onClick={() => runPreview(opt.frequency)}
                style={{ ...softBox, textAlign: 'left', cursor: 'pointer', fontFamily: FONTS.body, minHeight: 48, display: 'grid', gap: 2, opacity: previewing ? 0.55 : 1 }}
              >
                <span style={heading}>{OPTION_HEADING[opt.frequency] || cadenceOf(opt.frequency)}</span>
                <span style={line}>{opt.visitsPerYear} visits a year</span>
                <span style={line}>{fmtMoney(opt.perVisit)} a visit &middot; {fmtMoney(opt.perYear)} a year</span>
              </button>
            ))}
          </div>
        )}
        {messagesEnabled && (
          <OfficeMessage sentence={FEWER_VISITS_SENTENCE} linkLabel="Want fewer visits? Send us a message." ui={ui} />
        )}
      </>
    );
  } else if (step === 'review') {
    const kept = preview?.keptVisit;
    const fresh = Array.isArray(preview?.newVisits) ? preview.newVisits : [];
    const replaced = Array.isArray(preview?.replacedVisits) ? preview.replacedVisits : [];
    body = !preview ? (
      <div role="status" style={{ fontSize: 15, color: muted }}>Checking your schedule&hellip;</div>
    ) : (
      <>
        <div style={softBox}>
          <div style={heading}>Pest control {cadenceOf(preview.frequency)}</div>
          <div style={{ ...line, marginTop: 4 }}>{fmtMoney(preview.perVisit)} a visit &middot; {fmtMoney(preview.perYear)} a year</div>
          <div style={line}>Today: {fmtMoney(preview.today?.perVisit)} a visit &middot; {fmtMoney(preview.today?.perYear)} a year</div>
        </div>
        <div style={{ ...line, color: shell.text }}>
          {kept && <div>Your visit on {dayLabel(kept.date)} stays as booked at {fmtMoney(kept.perVisit)}.</div>}
          {fresh.length > 0 && (
            <div style={{ marginTop: kept ? 6 : 0 }}>
              Your new visits: {dayList(fresh.slice(0, 3))}{fresh.length > 3 ? ` and then ${cadenceOf(preview.frequency)}.` : ''}
            </div>
          )}
          {replaced.length > 0 && (
            <div style={{ marginTop: 6 }}>
              These replace the visits you had on {dayList(replaced.slice(0, 4))}{replaced.length > 4 ? ` and ${replaced.length - 4} more` : ''}.
            </div>
          )}
        </div>
        <div style={line}>Nothing is charged today. We bill each visit after it&apos;s done.</div>
        {errorBlock}
        <button
          type="button"
          data-glass-accent=""
          data-glass-size="primary"
          style={{ ...ui.primaryAction, opacity: confirming || previewing ? 0.55 : 1 }}
          disabled={confirming || previewing}
          onClick={confirm}
        >
          {confirming ? 'Confirming…' : 'Confirm change'}
        </button>
        <button type="button" data-glass-accent="" style={ui.secondaryAction} disabled={confirming} onClick={back}>
          Back
        </button>
      </>
    );
  } else {
    body = (
      <>
        <div style={{ textAlign: 'center', padding: '10px 0 0' }}>
          <IconTile icon="check" tone="success" size={60} />
        </div>
        <div style={{ textAlign: 'center', fontSize: 15, color: shell.text, lineHeight: 1.5 }}>
          Pest control is now {cadenceOf(result?.frequency || chosen)}. Your next visit is {dayLabel(nextVisit)}.
        </div>
        <button type="button" data-glass-accent="" data-glass-size="primary" style={ui.primaryAction} onClick={closeOverlay}>
          Done
        </button>
      </>
    );
  }

  // Portaled to <body>, same as the one-tap sheet: the entry sits inside a
  // glass card whose backdrop-filter would otherwise pin the overlay to it.
  return createPortal(
    <div data-glass-scrim={compact ? undefined : ''} style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: compact ? shell.page : 'rgba(15,23,42,0.48)',
      backdropFilter: compact ? 'none' : 'blur(5px)',
      display: 'flex',
      alignItems: compact ? 'stretch' : 'center',
      justifyContent: 'center',
      padding: compact ? 0 : 24,
    }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Change how often we visit"
        data-glass="modal"
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: compact ? 'none' : 560,
          height: compact ? '100%' : 'auto',
          maxHeight: compact ? 'none' : 'calc(100vh - 48px)',
          background: shell.page,
          borderRadius: compact ? 0 : 8,
          boxShadow: compact ? 'none' : '0 24px 70px rgba(15,23,42,0.28)',
          border: compact ? 'none' : `1px solid ${shell.border}`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header style={{
          flexShrink: 0,
          background: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(12px)',
          borderBottom: `1px solid ${shell.border}`,
          padding: compact
            ? 'calc(12px + env(safe-area-inset-top, 0px)) calc(14px + env(safe-area-inset-right, 0px)) 12px calc(14px + env(safe-area-inset-left, 0px))'
            : '14px 18px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <IconTile icon="calendar" size={34} />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: shell.text, lineHeight: 1.2, fontFamily: FONTS.body }}>{title}</h2>
          </div>
          <CloseButton onClick={closeOverlay} label="Close" />
        </header>
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: compact
            ? '16px calc(16px + env(safe-area-inset-right, 0px)) calc(16px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px))'
            : 20,
          display: 'grid',
          gap: 14,
          alignContent: 'start',
        }}>
          {body}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// The My Plan entry plus its sheet. data = usePestFrequency().data; renders
// nothing unless the server said available. onChanged re-runs the tab's loads.
export default function PestFrequencyChange({ data, ui, messagesEnabled = false, onChanged = () => {} }) {
  const [open, setOpen] = useState(false);
  if (data?.available !== true) return null;
  return (
    <>
      <button type="button" data-glass-accent="" style={ui.secondaryAction} onClick={() => setOpen(true)}>
        Change how often we visit
      </button>
      {open && (
        <PestFrequencyOverlay
          data={data}
          ui={ui}
          messagesEnabled={messagesEnabled}
          onClose={() => setOpen(false)}
          onChanged={onChanged}
        />
      )}
    </>
  );
}
