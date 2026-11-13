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
const STEP_TITLE = {
  choose: 'How often should we visit?',
  review: 'Review your new plan',
  done: 'Your plan is changed',
};
const FEWER_VISITS_SENTENCE = "I'd like fewer pest control visits.";
const GENERIC_ERROR = 'Something went wrong — please try again.';
const CHANGED_SENTENCE = 'Your schedule changed — please review the new dates.';
const UNAVAILABLE_SENTENCE = "We can't make this change online for your plan.";
const ERROR_TEXT = { fontSize: 14, color: '#9A3412', lineHeight: 1.5 };

const cadenceOf = (frequency) => CADENCE[frequency] || 'on a new schedule';
const dayLabel = (date) => formatETDateOnly(date, { month: 'short', day: 'numeric', year: 'numeric' }) || String(date || '');
// The Plan tab's own price words (per application, never "per visit").
const priceLine = (plan) => `${fmtMoney(plan?.perVisit)} per application · ${fmtMoney(plan?.perYear)} a year`;
const listOf = (value) => (Array.isArray(value) ? value : []);

// What the sheet shows for a failed preview or confirm.
function failureOf(err) {
  if (err?.code === 'FREQUENCY_CHANGE_UNAVAILABLE') return { kind: 'unavailable' };
  if (err?.status === 429 && err.message) return { kind: 'text', text: err.message };
  return { kind: 'text', text: GENERIC_ERROR };
}

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
      <div style={{ fontSize: 14, color: ui.shell.muted, lineHeight: 1.5 }}>
        We&apos;ll send this to the office: &quot;{sentence}&quot;
      </div>
      {state === 'failed' && <div role="alert" style={ERROR_TEXT}>{GENERIC_ERROR}</div>}
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

// The sheet's text and box styles, from the My Plan shell tokens. Sizes follow
// the customer type scale (theme-doc.js): 16 for what the customer reads to
// decide (`prose`), 14 for the price and billing notes under it (`line`).
function sheetStyles(ui) {
  return {
    softBox: { padding: '12px 14px', borderRadius: 10, background: ui.subtle, border: `1px solid ${ui.shell.border}` },
    heading: { fontSize: 16, fontWeight: 700, color: B.glassNavy },
    line: { fontSize: 14, color: ui.shell.muted, lineHeight: 1.5 },
    prose: { fontSize: 16, color: ui.shell.text, lineHeight: 1.5 },
  };
}

// A failed step. The server's "not available for this plan" keeps the office
// path: a message for the frequency the customer chose, or the phone number
// when Messages is off for this account.
function StepError({ error, chosen, ui, messagesEnabled }) {
  if (!error) return null;
  if (error.kind !== 'unavailable') return <div role="alert" style={ERROR_TEXT}>{error.text}</div>;
  const { softBox, prose } = sheetStyles(ui);
  if (!messagesEnabled) {
    return <div role="alert" style={{ ...softBox, ...prose }}>{UNAVAILABLE_SENTENCE} Call us at {WAVES_SUPPORT_PHONE_DISPLAY}.</div>;
  }
  return (
    <div role="alert" style={softBox}>
      <div style={prose}>{UNAVAILABLE_SENTENCE} Send us a message and we&apos;ll take care of it.</div>
      <div style={{ marginTop: 6 }}>
        <OfficeMessage sentence={`I'd like pest control visits ${cadenceOf(chosen)}.`} linkLabel="Send us a message" ui={ui} />
      </div>
    </div>
  );
}

// Step 1: the plan today and each plan with more visits, priced.
function ChooseStep({ data, ui, busy, messagesEnabled, onChoose, children }) {
  const { softBox, heading, line, prose } = sheetStyles(ui);
  const current = data.current || {};
  const options = listOf(data.options);
  return (
    <>
      <div style={line}>Today: {cadenceOf(current.frequency)} &middot; {priceLine(current)}</div>
      {children}
      {options.length === 0 && (
        <div style={{ ...softBox, ...prose }}>You&apos;re on our most frequent pest plan.</div>
      )}
      {options.length > 0 && (
        <div style={{ display: 'grid', gap: 10 }}>
          {options.map((opt) => (
            <button
              key={opt.frequency}
              type="button"
              disabled={busy}
              onClick={() => onChoose(opt.frequency)}
              style={{ ...softBox, textAlign: 'left', cursor: 'pointer', fontFamily: FONTS.body, minHeight: 48, display: 'grid', gap: 2, opacity: busy ? 0.55 : 1 }}
            >
              <span style={heading}>{OPTION_HEADING[opt.frequency] || cadenceOf(opt.frequency)}</span>
              <span style={line}>{opt.visitsPerYear} applications a year</span>
              <span style={line}>{priceLine(opt)}</span>
            </button>
          ))}
        </div>
      )}
      {messagesEnabled && (
        <OfficeMessage sentence={FEWER_VISITS_SENTENCE} linkLabel="Want fewer visits? Send us a message." ui={ui} />
      )}
    </>
  );
}

// A short list of dates, one on a line. `more` is the line for the dates not shown.
function DateLines({ title, dates, shown, more, style }) {
  if (!dates.length) return null;
  return (
    <div style={style}>
      <div style={{ fontWeight: 700 }}>{title}</div>
      {dates.slice(0, shown).map((date) => <div key={date}>{dayLabel(date)}</div>)}
      {dates.length > shown && <div>{more}</div>}
    </div>
  );
}

// Step 2: the server's preview. Nothing is written until Confirm change.
function ReviewStep({ preview, ui, busy, confirming, onConfirm, onBack, children }) {
  const { softBox, heading, line, prose } = sheetStyles(ui);
  // No accent: under the glass theme an accent button is gold, and Back must not look like Confirm.
  const backButton = (
    <button type="button" style={ui.secondaryAction} disabled={confirming} onClick={onBack}>
      Back
    </button>
  );
  if (!preview) {
    return (
      <>
        <div role="status" style={{ ...prose, color: ui.shell.muted }}>Checking your schedule&hellip;</div>
        {backButton}
      </>
    );
  }
  const kept = preview.keptVisit;
  const fresh = listOf(preview.newVisits);
  const replaced = listOf(preview.replacedVisits);
  return (
    <>
      <div style={softBox}>
        <div style={heading}>Pest control {cadenceOf(preview.frequency)}</div>
        <div style={{ ...line, marginTop: 4 }}>{priceLine(preview)}</div>
        <div style={line}>Today: {priceLine(preview.today)}</div>
      </div>
      {kept && <div style={prose}>Your visit on {dayLabel(kept.date)} stays as booked at {fmtMoney(kept.perVisit)}.</div>}
      <DateLines title="Your new visits" dates={fresh} shown={3} more={`and then ${cadenceOf(preview.frequency)}`} style={prose} />
      <DateLines title="These replace your visits on" dates={replaced} shown={4} more={`and ${replaced.length - 4} more`} style={prose} />
      <div style={line}>Nothing is charged today. You pay per application, after each visit.</div>
      {children}
      <button
        type="button"
        data-glass-accent=""
        data-glass-size="primary"
        style={{ ...ui.primaryAction, opacity: busy ? 0.55 : 1 }}
        disabled={busy}
        onClick={onConfirm}
      >
        {confirming ? 'Confirming…' : 'Confirm change'}
      </button>
      {backButton}
    </>
  );
}

// Step 3: the change is made. The next visit is the kept one, else the first new one.
function DoneStep({ result, ui, onDone }) {
  const { IconTile } = ui;
  const { prose } = sheetStyles(ui);
  const nextVisit = result.keptVisit?.date || listOf(result.newVisits)[0];
  return (
    <>
      <div style={{ textAlign: 'center', padding: '10px 0 0' }}>
        <IconTile icon="check" tone="success" size={60} />
      </div>
      <div style={{ ...prose, textAlign: 'center' }}>
        Pest control is now {cadenceOf(result.frequency)}.{nextVisit ? ` Your next visit is ${dayLabel(nextVisit)}.` : ''}
      </div>
      <button type="button" data-glass-accent="" data-glass-size="primary" style={ui.primaryAction} onClick={onDone}>
        Done
      </button>
    </>
  );
}

// The sheet's frame: the whole screen on a phone, a centered card on a wide window.
function frameStyles(shell, compact) {
  if (compact) {
    return {
      scrim: { background: shell.page, backdropFilter: 'none', alignItems: 'stretch', padding: 0 },
      dialog: { maxWidth: 'none', height: '100%', maxHeight: 'none', borderRadius: 0, boxShadow: 'none', border: 'none' },
      header: 'calc(12px + env(safe-area-inset-top, 0px)) calc(14px + env(safe-area-inset-right, 0px)) 12px calc(14px + env(safe-area-inset-left, 0px))',
      body: '16px calc(16px + env(safe-area-inset-right, 0px)) calc(16px + env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px))',
    };
  }
  return {
    scrim: { background: 'rgba(15,23,42,0.48)', backdropFilter: 'blur(5px)', alignItems: 'center', padding: 24 },
    dialog: {
      maxWidth: 560, height: 'auto', maxHeight: 'calc(100vh - 48px)', borderRadius: 8,
      boxShadow: '0 24px 70px rgba(15,23,42,0.28)', border: `1px solid ${shell.border}`,
    },
    header: '14px 18px',
    body: 20,
  };
}

// ui = the My Plan shell tokens PortalPage owns: { shell, subtle, primaryAction,
// secondaryAction, CloseButton, IconTile }. Passed in (as MovingEntry takes its
// styles) because PortalPage.jsx does not export them.
// Portaled to <body>, same as the one-tap sheet: the entry sits inside a glass
// card whose backdrop-filter would otherwise pin the overlay to it.
function SheetFrame({ title, ui, dialogRef, onClose, children }) {
  const compact = useIsMobile(760);
  const { shell, CloseButton, IconTile } = ui;
  const frame = frameStyles(shell, compact);
  return createPortal(
    <div
      data-glass-scrim={compact ? undefined : ''}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', justifyContent: 'center', ...frame.scrim }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Change how often we visit"
        data-glass="modal"
        style={{
          position: 'relative', width: '100%', background: shell.page, overflow: 'hidden',
          display: 'flex', flexDirection: 'column', ...frame.dialog,
        }}
      >
        <header style={{
          flexShrink: 0,
          background: 'rgba(255,255,255,0.96)',
          backdropFilter: 'blur(12px)',
          borderBottom: `1px solid ${shell.border}`,
          padding: frame.header,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <IconTile icon="calendar" size={34} />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: shell.text, lineHeight: 1.2, fontFamily: FONTS.body }}>{title}</h2>
          </div>
          <CloseButton onClick={onClose} label="Close" />
        </header>
        <div style={{ flex: 1, overflowY: 'auto', padding: frame.body, display: 'grid', gap: 14, alignContent: 'start' }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PestFrequencyOverlay({ data, ui, messagesEnabled, onClose, onChanged }) {
  useLockBodyScroll(true);
  const [step, setStep] = useState('choose'); // choose | review | done
  const [chosen, setChosen] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null); // null | { kind: 'unavailable' } | { kind: 'text', text }
  const confirmingRef = useRef(false);
  const previewSeq = useRef(0);
  const previewQueue = useRef(Promise.resolve());

  const closeOverlay = () => {
    if (confirmingRef.current) return;
    onClose();
    if (step === 'done') onChanged();
  };
  const dialogRef = useModalFocus(true, closeOverlay);

  // One look at a time. While a look at a plan still runs, the server answers
  // a second one with "try again", so a new choice waits for the last request
  // to finish; a choice that was replaced while it waited is never sent.
  const requestPreview = (frequency, seq) => {
    const call = previewQueue.current.then(() => (seq === previewSeq.current ? api.previewPestFrequency({ frequency }) : null));
    previewQueue.current = call.catch(() => {});
    return call;
  };

  const runPreview = async (frequency, { changed = false } = {}) => {
    const seq = ++previewSeq.current;
    setChosen(frequency);
    setPreviewing(true);
    setError(null);
    if (!changed) { setPreview(null); setStep('review'); }
    try {
      const shown = await requestPreview(frequency, seq);
      if (seq !== previewSeq.current) return;
      setPreview(shown);
      setStep('review');
      if (changed) setError({ kind: 'text', text: CHANGED_SENTENCE });
    } catch (err) {
      if (seq !== previewSeq.current) return;
      setError(failureOf(err));
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
      setError(failureOf(err));
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

  const stepError = <StepError error={error} chosen={chosen} ui={ui} messagesEnabled={messagesEnabled} />;
  return (
    <SheetFrame title={STEP_TITLE[step]} ui={ui} dialogRef={dialogRef} onClose={closeOverlay}>
      {step === 'choose' && (
        <ChooseStep data={data} ui={ui} busy={previewing} messagesEnabled={messagesEnabled} onChoose={runPreview}>{stepError}</ChooseStep>
      )}
      {step === 'review' && (
        <ReviewStep preview={preview} ui={ui} busy={confirming || previewing} confirming={confirming} onConfirm={confirm} onBack={back}>{stepError}</ReviewStep>
      )}
      {step === 'done' && <DoneStep result={result} ui={ui} onDone={closeOverlay} />}
    </SheetFrame>
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
