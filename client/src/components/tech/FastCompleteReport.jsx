// client/src/components/tech/FastCompleteReport.jsx
//
// The Fast Complete report flow's own pieces (GATE_FAST_COMPLETE_REPORT,
// owner "ok go" 2026-10-01 on the talk / generate / trace / send mockup):
// the customer-home choice, the 1–5 pest activity tracker, the photo strip,
// the promise check, the report the customer will see (read, edit, write
// again), what was heard from the technician's note, and the spray trace.
// FastCompleteSheet.jsx composes them with the products and the /complete
// submit it shares with the re-service sheet.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  PROMISE_MARKS, STILL_LEFT_MAX, currentMark, promiseCountLabel, promiseSourceLabel, toggledMarks,
} from '../schedule/PromiseCheck';
import { Chip, ChoiceSection } from './FastCompleteParts';
import { Button, Field, Input, Textarea, cn } from '../ui';
import '../../styles/tech-workflow.css';

// The full form's own three customer choices (its fourth, "Customer had
// specific concern", stays on the full form). The writer reads the full
// form's wording; the tiles say it shorter. Owner 2026-10-01: "not home —
// full access" is picked every time the sheet opens.
export const CUSTOMER_HOME_CHOICES = [
  { value: 'tech_home_spoke_with_them', label: 'Home — spoke with them', writerLabel: 'Customer home — spoke with them' },
  { value: 'not_home_full_access', label: 'Not home — full access', writerLabel: 'Customer not home — full access' },
  { value: 'not_home_partial_access', label: 'Not home — partial access', writerLabel: 'Customer not home — partial access' },
];
export const DEFAULT_CUSTOMER_HOME = 'not_home_full_access';
export const customerHomeWriterLabel = (value) => CUSTOMER_HOME_CHOICES.find((choice) => choice.value === value)?.writerLabel || '';

// The pest activity tracker on the full form's 0–5 scale, 1–5 here (owner
// 2026-10-01). Labels follow the server's active scale (tech-rating-allowed
// scaleLabels); these are only the fallback.
export const ACTIVITY_SCALE = [1, 2, 3, 4, 5];
const ACTIVITY_FALLBACK_LABELS = { 1: 'Very low', 2: 'Low', 3: 'Moderate', 4: 'Elevated', 5: 'High' };
export function activityLabel(rating, scaleLabels) {
  const label = scaleLabels?.[rating];
  return typeof label === 'string' && label.trim() ? label.trim() : ACTIVITY_FALLBACK_LABELS[rating];
}

// The first visit on a line opens at 5, as the full form's picker does
// (owner ruling 2026-09-24); the server re-checks it.
export const FIRST_VISIT_RATING = 5;

export function CustomerHomeSection({ value, locked, onChange }) {
  return (
    <ChoiceSection title="Customer" columns={1}>
      {CUSTOMER_HOME_CHOICES.map((choice) => (
        <Chip disabled={locked} key={choice.value} label={choice.label} pressed={value === choice.value} onClick={() => onChange(choice.value)} />
      ))}
    </ChoiceSection>
  );
}

export function ActivitySection({ value, scaleLabels, locked, onChange }) {
  const legendId = useId();
  const legend = ACTIVITY_SCALE.map((rating) => `${rating} = ${activityLabel(rating, scaleLabels).toLowerCase()}`).join(' · ');
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Pest activity</h3>
        <span className="tech-visit-muted">1–5</span>
      </div>
      <div role="group" aria-label="Pest activity" aria-describedby={legendId} className="tech-visit-tile-grid tech-visit-tile-grid--5">
        {ACTIVITY_SCALE.map((rating) => (
          <Button
            key={rating}
            type="button"
            variant="secondary"
            className="tech-visit-action tech-visit-product"
            aria-pressed={value === rating}
            aria-label={`${rating}, ${activityLabel(rating, scaleLabels).toLowerCase()}`}
            disabled={locked}
            onClick={() => onChange(rating)}
          >
            {rating}
          </Button>
        ))}
      </div>
      <p id={legendId} className="tech-visit-muted">{legend}</p>
    </section>
  );
}

// The visit's photos (staged against the visit by the photo manager), read
// again each time the manager closes. Their captions go to the report
// writer, so the report waits for the first read (`loaded`); a failed read
// counts as no photos, never a hold.
export function useVisitPhotos({ serviceId, request, version }) {
  const [state, setState] = useState({ photos: [], loaded: false });
  // Only the latest read may land: a read still in flight when the manager
  // closes must not overwrite the refreshed one.
  const readSequence = useRef(0);
  useEffect(() => {
    const sequence = ++readSequence.current;
    // Every read is pending until it lands: a photo added in the manager
    // must reach the report's freshness check before anything is sent.
    setState((prev) => (prev.loaded ? { ...prev, loaded: false } : prev));
    request(`/tech/services/${serviceId}/photos`)
      .then((data) => {
        if (sequence === readSequence.current) setState({ photos: Array.isArray(data?.photos) ? data.photos : [], loaded: true });
      })
      // The photo manager reports its own errors.
      .catch(() => { if (sequence === readSequence.current) setState({ photos: [], loaded: true }); });
    return () => { readSequence.current += 1; };
  }, [request, serviceId, version]);
  return state;
}

// What the writer is told about the photos, as the full form sends it: the
// first five captions, 200 characters each.
export function photoCaptionsOf(photos) {
  return (Array.isArray(photos) ? photos : [])
    .map((photo) => String(photo?.caption || '').trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((caption) => caption.slice(0, 200));
}

const PHOTO_STRIP_COUNT = 4;

export function PhotoStripSection({ photos, locked, onOpen }) {
  const count = photos.length;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Photos</h3>
        <span className="tech-visit-muted">{count ? `${count} added` : 'Optional'}</span>
      </div>
      {count > 0 && (
        <ul className="tech-report-photo-strip" aria-label="Photos added">
          {photos.slice(0, PHOTO_STRIP_COUNT).map((photo) => (
            <li key={photo.id || photo.s3_key || photo.url} className="tech-report-photo">
              {photo.url ? <img src={photo.url} alt={photo.caption || 'Visit photo'} /> : null}
              {photo.caption ? <span className="tech-report-photo-caption">{photo.caption}</span> : null}
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={onOpen} disabled={locked}>
        {count ? 'Add or view photos' : 'Add photos'}
      </Button>
    </section>
  );
}

// The promise check (GET /admin/dispatch/:id/promises): the customer's open
// promises a visit can keep, each marked Done, Partly or Not yet, or left
// blank. `available` is false while the report writer's rules are off or the
// visit is out of their scope, and on any failed read: the sheet then
// completes without the check, as the full form does.
export function useVisitPromises({ base, request }) {
  const [state, setState] = useState({ available: false, promises: [], total: 0, version: 0 });
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => request(`${base}/promises`))
      .then((data) => {
        if (cancelled) return;
        setState((prev) => (data?.available === true
          ? { available: true, promises: Array.isArray(data.promises) ? data.promises : [], total: Number(data.total) || 0, version: prev.version + 1 }
          : { available: false, promises: [], total: 0, version: prev.version + 1 }));
      })
      .catch(() => {
        if (!cancelled) setState((prev) => ({ available: false, promises: [], total: 0, version: prev.version + 1 }));
      });
    return () => { cancelled = true; };
  }, [base, request, reloads]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  return { ...state, reload };
}

export function PromisesSection({ promises, total, marks, locked, onChange }) {
  // Each mark keeps the wording version it was made against (PromiseCheck).
  const setMark = (promise, mark) => onChange(toggledMarks(marks, promise, mark));
  return (
    <section className="tech-visit-choice-section" aria-label="Promises we made">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Promises we made</h3>
        <span className="tech-visit-muted">{promiseCountLabel(promises.length, total)}</span>
      </div>
      {promises.map((promise) => {
        const entry = currentMark(marks, promise);
        return (
          <div key={promise.id} className="tech-visit-promise">
            <p className="tech-visit-promise-text">{promise.description}</p>
            <p className="tech-visit-muted">{promiseSourceLabel(promise)}</p>
            <div className="tech-visit-tile-grid tech-visit-tile-grid--3" role="group" aria-label={`Mark: ${promise.description}`}>
              {PROMISE_MARKS.map((option) => (
                <Chip
                  key={option.value}
                  disabled={locked}
                  label={option.label}
                  pressed={entry?.mark === option.value}
                  onClick={() => setMark(promise, option.value)}
                />
              ))}
            </div>
            {entry?.mark === 'partly' && (
              <Field label="What’s still left?" className="tech-visit-field">
                <Input
                  className="tech-visit-control"
                  value={entry.stillLeft || ''}
                  maxLength={STILL_LEFT_MAX}
                  disabled={locked}
                  onChange={(e) => onChange({ ...marks, [promise.id]: { ...entry, stillLeft: e.target.value } })}
                />
              </Field>
            )}
          </div>
        );
      })}
      <p className="tech-visit-muted">Promises left unmarked stay open and stay out of the report.</p>
    </section>
  );
}

// The visit's saved spray trace (GET /tech/services/:id/treatment-zone),
// read once and replaced by what the tracer saves. `enabled` is false while
// the treatment-zone map is off, and the trace step is then left out.
export function useVisitTrace({ serviceId, request }) {
  const [state, setState] = useState({ loaded: false, enabled: false, zone: null });
  useEffect(() => {
    let cancelled = false;
    request(`/tech/services/${serviceId}/treatment-zone`)
      .then((data) => {
        if (!cancelled) setState({ loaded: true, enabled: data?.enabled === true, zone: data?.treatmentZone || null });
      })
      .catch(() => { if (!cancelled) setState({ loaded: true, enabled: false, zone: null }); });
    return () => { cancelled = true; };
  }, [request, serviceId]);
  const saved = useCallback((zone) => setState((prev) => ({ ...prev, zone: zone || prev.zone })), []);
  return { ...state, saved };
}

// The traced perimeter's length, when the saved trace is a perimeter (with
// or without "Interior spray too", which keeps the perimeter's length): that
// length is the perimeter spray's linear feet on the record. A lawn or yard
// outline, or a trace with no length, is no perimeter.
const PERIMETER_CAPTURES = new Set(['perimeter', 'interior']);
export function perimeterFeetOf(zone) {
  if (!zone) return null;
  if (!PERIMETER_CAPTURES.has(zone.capture_mode ?? zone.captureMode ?? 'perimeter')) return null;
  const feet = Math.round(Number(zone.linear_ft ?? zone.linearFt));
  return Number.isFinite(feet) && feet > 0 ? feet : null;
}

export function TraceSection({ trace, locked, onTrace }) {
  const feet = perimeterFeetOf(trace.zone);
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Trace where we sprayed</h3>
        {trace.zone && <span className="tech-visit-muted">{feet ? `Perimeter traced · ${feet} ft` : 'Traced'}</span>}
      </div>
      <p className="tech-visit-muted">Drag along where you sprayed on the satellite photo of the home. The line shows on the customer’s report.</p>
      <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" disabled={locked} onClick={onTrace}>
        {trace.zone ? 'Trace again' : 'Trace where we sprayed'}
      </Button>
    </section>
  );
}

// The report's titled parts, as the server's parser reads them: each title
// on its own line or inline before its text ("WHAT WE FOUND: …"). Text
// before the first title, or a report with no titles, is one untitled part.
const REPORT_TITLES = [
  ['WHAT WE FOUND', 'What we found'],
  ['WHAT WE DID AND WHY', 'What we did and why'],
  ['WHAT WE DID', 'What we did'],
  ['WHAT TO EXPECT', 'What to expect'],
  ["WHAT'S NEXT", 'What’s next'],
];
// Titles are capitals, alone on their line or before a colon, so a sentence
// that opens "What we found…" stays text.
const TITLE_RE = new RegExp(`^(${REPORT_TITLES.map(([title]) => title.replace("'", "['’]")).join('|')})\\s*(?::\\s*(.*))?$`);

export function reportParts(text) {
  const parts = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = TITLE_RE.exec(line);
    if (match) {
      const key = match[1].toUpperCase().replace('’', "'");
      current = { title: REPORT_TITLES.find(([title]) => title === key)[1], lines: match[2]?.trim() ? [match[2].trim()] : [] };
      parts.push(current);
      continue;
    }
    if (!current) {
      current = { title: null, lines: [] };
      parts.push(current);
    }
    current.lines.push(line);
  }
  return parts.map((part) => ({ title: part.title, text: part.lines.join(' ') }));
}

// What went into the report, shown while it is written.
export function WritingView({ sources }) {
  return (
    <div className="tech-visit-card" role="status" aria-live="polite">
      <p className="tech-visit-section-title">Writing the report…</p>
      <p className="tech-visit-muted">Writing from</p>
      <ul className="tech-report-sources">
        {sources.map((source) => <li key={source}>{source}</li>)}
      </ul>
    </div>
  );
}

// "Heard from you": the record facts read from the note (where product
// went down, the pests named), fixed by talking again and writing again.
// Shown once the note was read; why a read holds the send is the footer's.
const joinAnd = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] || '');
const FACTS_READ = new Set(['read', 'empty_note']);

// Why the note's read holds Complete & send, or '': where product went down
// decides the customer's re-entry wait, so it must have been heard.
export function factsHold(facts) {
  if (facts?.status === 'too_long') return 'Your note is too long to read where you treated. Shorten it, then write it again.';
  if (!FACTS_READ.has(facts?.status)) return 'Couldn’t read where you treated from your note. Write it again to retry.';
  // Heard, but the note also denies it: never recorded, never dropped.
  const unclear = facts.unclearAreas || [];
  if (unclear.length) {
    return `It isn’t clear whether you treated ${joinAnd(unclear.map((area) => area.toLowerCase()))}. Say plainly where you treated, then write it again.`;
  }
  return facts.areas.length ? '' : 'Say where you treated (inside, outside or garage) in your note, then write it again.';
}

const SPRAY_HEARD = { perimeter: 'perimeter spray', spot: 'spot spraying' };

function HeardLine({ facts }) {
  if (!FACTS_READ.has(facts?.status)) return null;
  const unclear = facts.unclearAreas || [];
  const heard = [
    facts.areas.length ? `treated ${joinAnd(facts.areas.map((area) => area.toLowerCase()))}` : (unclear.length ? '' : 'where you treated: not heard'),
    unclear.length ? `not clear: ${joinAnd(unclear.map((area) => area.toLowerCase()))}` : '',
    SPRAY_HEARD[facts.spray],
    facts.pests.length ? `for ${facts.pests.join(', ')}` : '',
  ].filter(Boolean);
  return (
    <p className="tech-visit-muted" data-testid="fast-complete-heard">
      Heard from you: {heard.join(' · ')}
    </p>
  );
}

function withLine(photoCount, traced) {
  const photos = photoCount ? `your ${photoCount} photo${photoCount === 1 ? '' : 's'}` : '';
  const items = [photos, traced ? 'the trace' : ''].filter(Boolean);
  return items.length ? `With ${items.join(' and ')}.` : '';
}

export function ReportCard({
  draft, editing, stale, locked, photoCount, traced, onEdit, onDoneEditing, onChangeText, onWriteAgain,
}) {
  const textId = useId();
  const edited = draft.text.trim() !== draft.base.trim();
  const parts = reportParts(draft.text);
  const extra = withLine(photoCount, traced);
  return (
    <section className="tech-visit-card tech-report-card" aria-labelledby={`${textId}-title`}>
      <div className="tech-visit-section-head">
        <h3 id={`${textId}-title`} className="tech-visit-section-title">Report the customer will see</h3>
        <span className="tech-visit-muted">{edited ? 'Edited by you' : 'Written for you'}</span>
      </div>
      {draft.deterministic && (
        <p className="tech-visit-muted">The writer was unavailable, so this is the standard report. Write again to try the writer.</p>
      )}
      {stale && (
        <p className="tech-visit-muted tech-visit-status--warn" role="status">You changed the visit after this report was written. Write it again so it matches{edited ? "; that replaces your edits" : ""}.</p>
      )}
      {editing ? (
        <Field label="Edit the report" className="tech-visit-field">
          <Textarea id={textId} className="tech-visit-control" rows={12} value={draft.text} disabled={locked} onChange={(e) => onChangeText(e.target.value)} />
        </Field>
      ) : (
        <div className="tech-report-parts">
          {parts.map((part, index) => (
            <div key={`${part.title || 'text'}-${index}`}>
              {part.title && <h4 className="tech-report-part-title">{part.title}</h4>}
              <p className="tech-report-part-text">{part.text}</p>
            </div>
          ))}
        </div>
      )}
      {extra && <p className="tech-visit-muted">{extra}</p>}
      <HeardLine facts={draft.facts} />
      <div className="tech-visit-tile-grid">
        <Chip disabled={locked} label={editing ? 'Done editing' : 'Edit'} onClick={editing ? onDoneEditing : onEdit} />
        <Chip disabled={locked} label="Write again" onClick={onWriteAgain} />
      </div>
    </section>
  );
}

// A footer for a step that is not the completion itself: the reason it is
// held, then one full-width action (`children` go first, e.g. "Check stock").
export function StepFooter({ reason, warn, label, onAction, busy, disabled, coverProps, children }) {
  return (
    <footer className="tech-visit-footer tech-visit-footer--stacked" {...coverProps}>
      {reason && <p className={cn('tech-visit-muted', warn && 'tech-visit-status--warn')} role="status">{reason}</p>}
      <div className="tech-visit-actions">
        {children}
        <Button className="tech-visit-action tech-visit-complete tech-visit-wide" onClick={onAction} loading={busy} disabled={disabled || !!reason}>
          {label}
        </Button>
      </div>
    </footer>
  );
}

// A confirmable completion prompt (the edited-report heads-up, a promise
// that changed after the report was written): the server's own words, then
// send as is or go back.
export function ConfirmPrompt({ prompt, onConfirm, onBack, busy }) {
  return (
    <div className={cn('tech-visit-card', 'tech-report-confirm')} role="alertdialog" aria-label="Before this goes out">
      <p className="tech-visit-section-title">Before this goes out</p>
      {String(prompt.message || '').split('\n').filter(Boolean).map((line) => (
        <p key={line} className="tech-visit-muted">{line}</p>
      ))}
      <div className="tech-visit-tile-grid">
        <Chip label="Go back" disabled={busy} onClick={onBack} />
        <Chip label="Send as is" disabled={busy} onClick={onConfirm} />
      </div>
    </div>
  );
}

const money = (value) => `$${Number(value).toFixed(2)}`;
// What became of the report text, from the completion's own status and
// reason: a held, blocked or failed text says so, never silence.
// The completion's status says whether the report went, not how: a customer
// who prefers the app gets it there, so the words never say "text".
const SMS_RESULT = {
  sent: () => 'The report went to the customer.',
  sending: () => 'The report is on its way to the customer.',
  deferred: () => 'The report is queued and goes out in the customer’s messaging hours.',
  no_phone: () => 'No phone on file, so nothing was sent. The report is in the customer’s portal.',
  skipped_recap_sms_already_sent: () => 'A message already went to the customer for this visit.',
  suppressed_delivery_mode: () => 'Nothing was sent: this visit’s report is not sent to customers.',
  blocked: (reason) => `Nothing was sent: ${reason || 'the customer’s message settings held it'}.`,
  failed: (reason) => `The report did not go out${reason ? ` (${reason})` : ''}. The office can resend it.`,
};
function smsLine(result) {
  const status = result?.completionSmsStatus;
  if (!status || status === 'not_requested') return null;
  const reason = String(result.completionSmsError || '').trim();
  return SMS_RESULT[status]?.(reason) || `Nothing was sent to the customer${reason ? `: ${reason}` : ''}.`;
}

function billLine(result) {
  if (!result?.invoiceId) return null;
  if (result.invoiceStatus === 'paid') return 'Bill: paid.';
  if (result.invoiceStatus === 'processing') return 'Bill: payment processing.';
  // invoiceTotal is the amount still due, so a paid bill names no amount.
  const due = Number(result.invoiceTotal);
  return result.invoiceTotal != null && Number.isFinite(due) && due > 0 ? `Bill: ${money(due)} due.` : null;
}

// Which promises marked Done the completion closed: marks are applied before
// /complete answers, and a reworded or failed one stays open (the office is
// told). Read back from the open list, never assumed from the taps.
function usePromisesStillOpen({ base, request, ids }) {
  const [open, setOpen] = useState(null);
  const key = ids.join(',');
  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    request(`${base}/promises?include=${encodeURIComponent(key)}`)
      .then((data) => {
        if (!cancelled && data?.available === true) setOpen(new Set((data.promises || []).map((promise) => String(promise.id))));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [base, request, key]);
  return open;
}

// After Complete & send: what the server says went out, what it billed, and
// which promises it closed.
export function SentSummary({ result, doneMarks = [], base, request }) {
  const open = usePromisesStillOpen({ base, request, ids: doneMarks.map((mark) => String(mark.id)) });
  if (!result) return null;
  const lines = [smsLine(result), billLine(result)].filter(Boolean);
  return (
    <div data-testid="fast-complete-sent">
      {lines.map((line) => <p key={line} className="tech-visit-muted">{line}</p>)}
      {open && doneMarks.map((mark) => (
        <p key={mark.id} className="tech-visit-muted">
          {open.has(String(mark.id)) ? `Still open: ${mark.description}. The office will settle it.` : `Promise closed: ${mark.description}`}
        </p>
      ))}
    </div>
  );
}

// A bill the completion says still needs collecting on the spot: an unpaid
// invoice whose pay link did not go out with the report (a blocked text, no
// phone). The rule Dispatch applies after a completion (DispatchPageV2
// applyCompletionResult); null when nothing is owed now.
const INVOICE_TEXT_TYPES = new Set(['service_complete_with_invoice', 'service_report_v1_with_invoice']);
export function collectibleBill(result) {
  const amount = Number(result?.invoiceTotal || 0);
  const linkWent = INVOICE_TEXT_TYPES.has(result?.completionSmsType) && result?.completionSmsStatus === 'sent';
  const owed = result?.invoiceId && result?.invoiceToken && amount > 0
    && result?.invoicePaymentActionRequired !== false && result?.invoiceStatus !== 'paid';
  return owed && !linkWent ? { invoiceId: result.invoiceId, invoiceToken: result.invoiceToken, amount } : null;
}

// Collect it on the spot: the customer's own pay page for this invoice (the
// page the report's pay link opens: card, Apple Pay, bank), opened in a new
// tab on the tech's phone. It works for every tech role and never stacks a
// second dialog over the sheet; otherwise the office's follow-ups take it.
export function CollectPayment({ result }) {
  const bill = useMemo(() => collectibleBill(result), [result]);
  if (!bill) return null;
  const openPayPage = () => window.open(`/pay/${encodeURIComponent(bill.invoiceToken)}`, '_blank', 'noopener,noreferrer');
  return (
    <div data-testid="fast-complete-collect">
      <p className="tech-visit-muted">The pay link did not reach the customer. They can pay now on your phone, or the office follows up.</p>
      <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={openPayPage}>
        Take payment now ({money(bill.amount)})
      </Button>
    </div>
  );
}
