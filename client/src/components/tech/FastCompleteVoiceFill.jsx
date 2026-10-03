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
// The server keeps this much of an office note (complete-scheduled-service.js
// OFFICE_NOTE_MAX_CHARS); the box never holds more.
export const OFFICE_NOTE_MAX_CHARS = 800;

// The sheet's voice-fill state: Checks, Heard lines, the office note, and
// `apply`, which turns one fill into taps. `sheet` carries the sheet's own
// pieces: { ops, ctx, products, form, setForm, chooseMethod, appendNote }.
export function useVoiceFillSheet({ enabled, request, serviceId, sheet }) {
  const { fill, status, error, unavailable } = useVoiceFill({ request, serviceId, sheet: VOICE_SHEET });
  const [checks, setChecks] = useState([]);
  // What the fill set, until the tech taps ✓ or changes it (one tap per product,
  // visit taps too: owner 2026-10-02).
  const [confirms, setConfirms] = useState([]);
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
    // a newer fill of the same field replaces the older confirm
    setConfirms((prev) => [
      ...prev.filter((old) => !plan.confirms.some((next) => next.watch === old.watch)),
      ...plan.confirms.map((confirm) => ({ ...confirm, id: ++nextId.current })),
    ]);
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
  // Changing what a confirm points at is the tech's own tap: it is confirmed.
  useEffect(() => {
    setChecks((prev) => (prev.length ? unresolvedChecks(prev, rows, form) : prev));
    setConfirms((prev) => (prev.length ? unresolvedChecks(prev, rows, form) : prev));
  }, [rows, form]);

  const dismiss = useCallback((id) => setChecks((prev) => prev.filter((check) => check.id !== id)), []);
  const confirm = useCallback((id) => setConfirms((prev) => prev.filter((item) => item.id !== id)), []);

  // A 404 later (gate turned off) takes the mic away, never what is already on
  // the sheet: open Checks, confirms and the office note stay reachable while
  // they hold Complete.
  const pending = checks.length > 0 || confirms.length > 0 || officeNote.trim() !== '';
  return {
    enabled: enabled && (!unavailable || pending),
    micEnabled: enabled && !unavailable,
    filling: status === 'filling',
    error,
    checks,
    confirms,
    confirm,
    officeNoteTooLong: officeNote.length > OFFICE_NOTE_MAX_CHARS,
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
  const { listening, supported, toggle, starting, uploading } = useSpeechDictation(
    (text) => chunks.current.push(text),
    { uploadServiceId: serviceId },
  );
  // Words still being heard, recorded or transcribed would miss the save: in
  // browser speech too, since a Complete tap would stop it before its words
  // are filled in (unlike plain field dictation, the fill is not instant).
  const pending = starting || listening || uploading;
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

// What the fill set, each waiting on the tech's ✓ (or a change to it).
function ConfirmSection({ confirms, locked, onConfirm }) {
  if (!confirms.length) return null;
  return (
    <section className="tech-visit-choice-section" aria-label="Confirm what I filled">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Confirm what I filled</h3>
        <span className="tech-visit-muted">{confirms.length === 1 ? '1 to confirm' : `${confirms.length} to confirm`}</span>
      </div>
      <ul className="tech-visit-check-list">
        {confirms.map((item) => (
          <li key={item.id} className="tech-visit-check">
            <span className="tech-visit-check-text">
              {item.text}
              {item.heard && <span className="tech-visit-heard">{`Heard: \u201C${item.heard}\u201D`}</span>}
            </span>
            <Button type="button" variant="secondary" className="tech-visit-action" disabled={locked} aria-label={`Confirm ${item.text}`} onClick={() => onConfirm(item.id)}>
              {'✓ Right'}
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

// The mic sits OUTSIDE the sheet's form block: while it is live that whole block
// is disabled (any other tap or keystroke ends the browser's speech session and
// drops the words in flight), and the mic must stay tappable to stop.
export function VoiceFillMicBar({ voice, serviceId, locked, onPendingChange }) {
  if (!voice.micEnabled) return null;
  return <VoiceFillMic serviceId={serviceId} locked={locked} filling={voice.filling} error={voice.error} onWords={voice.onWords} onPendingChange={onPendingChange} />;
}

// Inside the form block: what the fill set (to confirm) and could not settle.
export function VoiceFillReview({ voice, locked }) {
  if (!voice.enabled) return null;
  return (
    <>
      <ConfirmSection confirms={voice.confirms} locked={locked} onConfirm={voice.confirm} />
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
        maxLength={OFFICE_NOTE_MAX_CHARS}
        aria-invalid={voice.officeNoteTooLong || undefined}
        onChange={(e) => voice.setOfficeNote(e.target.value)}
        placeholder="Gate codes, access, anything the office should know"
      />
      {voice.officeNoteTooLong && (
        <p className="tech-visit-muted tech-visit-status--warn" role="status">{`Office note is over ${OFFICE_NOTE_MAX_CHARS} characters. Shorten it to complete.`}</p>
      )}
    </section>
  );
}
