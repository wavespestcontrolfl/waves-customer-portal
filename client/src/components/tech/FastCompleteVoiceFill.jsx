// client/src/components/tech/FastCompleteVoiceFill.jsx
//
// Fast Complete voice fill (GATE_FAST_COMPLETE_VOICE_FILL), the sheet half: the
// "Tell me what you did" mic, the Check chips, the muted "Heard: ..." lines and
// the office note. The words go to hooks/useVoiceFill.js; the answer becomes
// ordinary taps through lib/fast-complete-voice-plan.js and the sheet's own
// state setters. Nothing is completed from here, and the transcript is never
// kept: it is passed to the fill and dropped.
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import useSpeechDictation from '../../hooks/useSpeechDictation';
import useVoiceFill from '../../hooks/useVoiceFill';
import { planVoiceFill, unresolvedChecks } from '../../lib/fast-complete-voice-plan';
import { Button, Textarea } from '../ui';
import '../../styles/tech-workflow.css';

const VOICE_SHEET = 'pest_reservice';

// The sheet's voice-fill state: Checks, Heard lines, the office note, and
// `apply`, which turns one fill into taps. `sheet` carries the sheet's own
// pieces: { ops, ctx, products, form, setForm, chooseMethod, appendNote }.
export function useVoiceFillSheet({ enabled, request, serviceId, sheet }) {
  const { fill, status, error, unavailable } = useVoiceFill({ request, serviceId, sheet: VOICE_SHEET });
  const [checks, setChecks] = useState([]);
  const [heard, setHeard] = useState({ products: {}, visit: '' });
  const [officeNote, setOfficeNote] = useState('');
  const nextId = useRef(0);
  // The fill lands later than it was asked for: plan it against the sheet as
  // it is when it arrives, so a tap made meanwhile is kept.
  const latest = useRef(sheet);
  latest.current = sheet;

  const apply = useCallback((result) => {
    const { ops, ctx, products, form, setForm, chooseMethod, appendNote } = latest.current;
    const plan = planVoiceFill({ fill: result, rows: products.rows, form, ctx, ops });
    products.applyFill(plan.added, plan.patches);
    const { method, ...visitPatch } = plan.formPatch;
    if (Object.keys(visitPatch).length) setForm((prev) => ({ ...prev, ...visitPatch }));
    if (method) chooseMethod(method);
    if (plan.customerNote) appendNote(plan.customerNote);
    if (plan.officeNote) setOfficeNote((prev) => (prev.trim() ? `${prev.trimEnd()}\n${plan.officeNote}` : plan.officeNote));
    setHeard((prev) => ({ products: { ...prev.products, ...plan.heard.products }, visit: plan.heard.visit || prev.visit }));
    setChecks((prev) => [...prev, ...plan.checks.map((check) => ({ ...check, id: ++nextId.current }))]);
  }, []);

  // What the tech said, once: a fill that answers is applied, nothing else is.
  const onWords = useCallback(async (words) => {
    const result = await fill(words);
    if (result) apply(result);
  }, [fill, apply]);

  // Fixing the field a Check points at clears it.
  const { rows } = sheet.products;
  const { form } = sheet;
  useEffect(() => {
    setChecks((prev) => (prev.length ? unresolvedChecks(prev, rows, form) : prev));
  }, [rows, form]);

  const dismiss = useCallback((id) => setChecks((prev) => prev.filter((check) => check.id !== id)), []);

  return {
    enabled: enabled && !unavailable,
    filling: status === 'filling',
    error,
    checks,
    heard,
    officeNote,
    setOfficeNote,
    dismiss,
    onWords,
  };
}

function MicIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function micLabel({ listening, uploading, filling }) {
  if (filling) return 'Filling from your words…';
  if (uploading) return 'Transcribing…';
  return listening ? 'Tap when you are done' : 'Tell me what you did';
}

// The words so far are kept in this component only until the mic is idle; then
// they are handed on once and dropped. Browser speech gives chunks as you talk;
// the clip upload gives one transcript after you stop.
function VoiceFillMic({ serviceId, locked, filling, error, onWords, onPendingChange }) {
  const chunks = useRef([]);
  const { listening, supported, toggle, mode, starting, uploading } = useSpeechDictation(
    (text) => chunks.current.push(text),
    { uploadServiceId: serviceId },
  );
  // A clip still being recorded or transcribed would miss the save.
  const pending = mode === 'upload' && (starting || listening || uploading);
  useEffect(() => {
    onPendingChange?.(pending);
    return () => onPendingChange?.(false);
  }, [pending, onPendingChange]);

  const idle = !listening && !uploading && !starting;
  useEffect(() => {
    if (!idle || !chunks.current.length) return;
    const words = chunks.current.join(' ').trim();
    chunks.current = [];
    if (words) onWords(words);
  }, [idle, onWords]);

  const label = micLabel({ listening, uploading, filling });
  return (
    <section className="tech-visit-choice-section">
      {supported && (
        <Button
          type="button"
          variant="secondary"
          className="tech-visit-action tech-visit-wide tech-voice-mic"
          onClick={toggle}
          disabled={locked || filling || uploading}
          aria-pressed={listening}
          aria-busy={filling || uploading || undefined}
        >
          <MicIcon />
          {label}
        </Button>
      )}
      {error && <p className="tech-visit-muted tech-visit-status--warn" role="status">{error}</p>}
    </section>
  );
}

// What the fill could not settle. Each one holds Complete until the tech taps
// it away or fixes the field it points at.
function ChecksSection({ checks, locked, onDismiss }) {
  if (!checks.length) return null;
  return (
    <section className="tech-visit-choice-section" aria-label="Check">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Check</h3>
        <span className="tech-visit-muted">{checks.length === 1 ? '1 to look at' : `${checks.length} to look at`}</span>
      </div>
      <ul className="tech-visit-check-list">
        {checks.map((check) => (
          <li key={check.id} className="tech-visit-check">
            <span className="tech-visit-check-text">{check.text}</span>
            <Button type="button" variant="secondary" className="tech-visit-action" disabled={locked} onClick={() => onDismiss(check.id)}>
              {'✓ Got it'}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// A small muted "Heard: ..." under what the words filled.
function HeardLine({ children }) {
  if (!children) return null;
  return <p className="tech-visit-heard">Heard: {children}</p>;
}

// The three places the sheet shows voice fill; each shows nothing with it off.

// At the top: the mic, then what the fill could not settle.
export function VoiceFillTop({ voice, serviceId, locked, onPendingChange }) {
  if (!voice.enabled) return null;
  return (
    <>
      <VoiceFillMic serviceId={serviceId} locked={locked} filling={voice.filling} error={voice.error} onWords={voice.onWords} onPendingChange={onPendingChange} />
      <ChecksSection checks={voice.checks} locked={locked} onDismiss={voice.dismiss} />
    </>
  );
}

// One line per filled product row still on the sheet.
export function ProductHeardLines({ voice, rows }) {
  if (!voice.enabled) return null;
  return rows.filter((row) => voice.heard.products[row.productId]).map((row) => (
    <HeardLine key={row.productId}>{`\u201C${voice.heard.products[row.productId]}\u201D`}</HeardLine>
  ));
}

export function VisitHeardLine({ voice }) {
  if (!voice.enabled || !voice.heard.visit) return null;
  return <HeardLine>{`\u201C${voice.heard.visit}\u201D`}</HeardLine>;
}

// Internal: for the office, never on the customer report.
export function OfficeNote({ voice, locked }) {
  const id = useId();
  if (!voice.enabled) return null;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title"><label htmlFor={id}>Office note (not on the report)</label></h3>
      </div>
      <Textarea
        id={id}
        className="tech-visit-control"
        rows={2}
        value={voice.officeNote}
        disabled={locked}
        onChange={(e) => voice.setOfficeNote(e.target.value)}
        placeholder="Gate codes, access, anything the office should know"
      />
    </section>
  );
}
