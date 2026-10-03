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
import { blogPostPath, useBlogPostSearch } from '../schedule/BlogPostPicker';
import { ActionFeedback, Button, Field, Input, Textarea, cn } from '../ui';
import NoteBoxPhotos from '../schedule/NoteBoxPhotos';
import { reconcileDependentFindingSelections, specialtyCompletedWorkWithoutAction } from '../../lib/service-completion-presets';
import { typedFieldLabel, typedFieldRequiredNow } from '../../lib/typed-findings-rules';
import { formatETDateOnly } from '../../lib/timezone';
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
// With the photos in the note's box (`keepOnFailure`), a failed read is no
// confirmed answer: `failed` holds the report until a read lands, the first
// read too (codex local r2 and the pre-push P1 after it on #5624: a photo
// the manager added, or one already on the visit, must reach the report),
// and the photos last read stay on screen, so a dropped connection never
// empties the box under an open description (codex local r1). The sheet
// mounts once per visit, so the photos kept are always this visit's. `update` applies a change the server already took (a
// description saved, a photo removed) to the photos at once (pre-push P1).
export function useVisitPhotos({ serviceId, request, version, keepOnFailure = false }) {
  const [state, setState] = useState({ photos: [], loaded: false, failed: false, read: false });
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
        if (sequence !== readSequence.current) return;
        // A reply with no photo list (an unreadable body answers {}) is no
        // answer either, in the note's box (codex local r4 on #5624).
        if (keepOnFailure && !Array.isArray(data?.photos)) {
          setState((prev) => ({ ...prev, loaded: true, failed: true }));
          return;
        }
        setState({ photos: Array.isArray(data?.photos) ? data.photos : [], loaded: true, failed: false, read: true });
      })
      // The photo manager reports its own errors.
      .catch(() => {
        if (sequence !== readSequence.current) return;
        setState((prev) => (keepOnFailure
          ? { ...prev, loaded: true, failed: true }
          : { photos: [], loaded: true, failed: false, read: prev.read }));
      });
    return () => { readSequence.current += 1; };
  }, [request, serviceId, version, keepOnFailure]);
  const update = useCallback((change) => setState((prev) => ({ ...prev, photos: change(prev.photos) })), []);
  return { ...state, update };
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

// Photos in the note's box (GATE_NOTE_BOX_PHOTOS, owner "ok go" 2026-10-02
// on the Fast Complete mockup v8, call 10): the visit's photos sit in the
// note's box, each with its description, through the office form's own
// NoteBoxPhotos. These photos are already staged on the visit (the photo
// manager adds them), so a description is saved and a photo removed on the
// server (PATCH / DELETE /tech/services/:id/photos/:photoId) and then read
// again; a removal asks first, as the file is deleted for good. `onHold`
// tells the sheet what holds the report meanwhile: an open description, a
// change being saved, or a removal waiting for its answer.
const NOTE_PHOTO_PALETTE = {
  text: 'var(--tech-text)', muted: 'var(--tech-muted)', border: 'var(--tech-border)', card: 'var(--tech-card)', danger: '#ef4444', onDanger: '#fff',
};
const NOTE_PHOTO_ERRORS = {
  photo_caption_banned_copy: 'That description has wording we can’t put on a customer’s report. Describe the photo in other words.',
  visit_completed: 'This visit is completed; its photos are on the report.',
  photo_not_found: 'That photo is no longer on this visit.',
};

export function TechNoteBoxPhotos({ serviceId, request, photos, disabled, readFailed, onAdd, onUpdate, onChanged, onRetry, onHold }) {
  const [describing, setDescribing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState('');
  const hold = (saving && 'Saving the photo change…')
    || (describing && 'Save or cancel the photo description first.')
    || (removing && 'Remove the photo or keep it first.')
    || '';
  useEffect(() => { onHold(hold); }, [hold, onHold]);
  useEffect(() => () => onHold(''), [onHold]);
  // One change at a time; true once the server took it, and then applied
  // to the photos at once (`applied`, from the server's answer). Either way
  // the box reads the visit's photos again, so it shows what the visit holds.
  const change = async (photo, options, applied) => {
    if (!photo?.id) return false;
    setSaving(true);
    setError('');
    try {
      const answer = await request(`/tech/services/${serviceId}/photos/${photo.id}`, options);
      onUpdate((list) => applied(list, answer));
      return true;
    } catch (err) {
      setError(NOTE_PHOTO_ERRORS[err?.code] || 'Couldn’t save the photo change. Try again.');
      return false;
    } finally {
      setSaving(false);
      onChanged();
    }
  };
  return (
    <>
      <NoteBoxPhotos
        photos={photos}
        disabled={disabled || saving || !!removing}
        palette={NOTE_PHOTO_PALETTE}
        dictationServiceId={serviceId}
        // The photo manager covers the sheet: it never opens over a
        // description, whose mic may be recording (codex local r2).
        addLockedWhileEditing
        onAdd={onAdd}
        onEditingChange={setDescribing}
        onCaption={(index, caption) => {
          const photo = photos[index];
          return change(photo, { method: 'PATCH', body: JSON.stringify({ caption }) }, (list, answer) => list.map((each) => (
            each.id === photo?.id
              ? { ...each, caption: answer?.photo && 'caption' in answer.photo ? answer.photo.caption : caption }
              : each
          )));
        }}
        onRemove={(index) => { setError(''); setRemoving(photos[index] || null); }}
      />
      {(removing || error || readFailed) && (
        <div className="tech-note-photo-after">
          {readFailed && (
            <div className="tech-note-photo-confirm">
              <ActionFeedback error className="tech-visit-feedback">Couldn’t read the visit’s photos. Check the connection.</ActionFeedback>
              <div className="tech-note-photo-confirm-actions">
                <Button type="button" variant="secondary" className="tech-visit-action" onClick={onRetry} disabled={disabled}>Read the photos again</Button>
              </div>
            </div>
          )}
          {removing && (
            <div className="tech-note-photo-confirm" role="group" aria-label="Remove photo">
              <p className="tech-visit-muted">Remove this photo? It’s deleted from the visit for good.</p>
              <div className="tech-note-photo-confirm-actions">
                <Button
                  type="button"
                  variant="secondary"
                  className="tech-visit-action"
                  onClick={() => {
                    const photo = removing;
                    setRemoving(null);
                    change(photo, { method: 'DELETE' }, (list) => list.filter((each) => each.id !== photo.id));
                  }}
                >
                  Remove photo
                </Button>
                <Button type="button" variant="secondary" className="tech-visit-action" onClick={() => setRemoving(null)}>Keep</Button>
              </div>
            </div>
          )}
          {error && <ActionFeedback error className="tech-visit-feedback">{error}</ActionFeedback>}
        </div>
      )}
    </>
  );
}

// The promise check (GET /admin/dispatch/:id/promises): the customer's open
// promises a visit can keep, each marked Done, Partly or Not yet, or left
// blank. `available` is false while the report writer's rules are off or the
// visit is out of their scope, and on any failed read: the sheet then
// completes without the check, as the full form does.
// loaded: the first read has answered (a failed read too: the check fails
// open), so the report is never written before the list could show.
export function useVisitPromises({ base, request }) {
  const [state, setState] = useState({ available: false, promises: [], total: 0, version: 0, loaded: false });
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => request(`${base}/promises`))
      .then((data) => {
        if (cancelled) return;
        setState((prev) => (data?.available === true
          ? { available: true, promises: Array.isArray(data.promises) ? data.promises : [], total: Number(data.total) || 0, version: prev.version + 1, loaded: true }
          : { available: false, promises: [], total: 0, version: prev.version + 1, loaded: true }));
      })
      .catch(() => {
        if (!cancelled) setState((prev) => ({ available: false, promises: [], total: 0, version: prev.version + 1, loaded: true }));
      });
    return () => { cancelled = true; };
  }, [base, request, reloads]);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  return { ...state, reload };
}

// The Waves blog search (GATE_REPORT_BLOG_POST): offered while the server
// answers available for this visit (its own service line is pest). A failed
// read is no section.
export function useBlogPostOffer({ base, request }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => request(`${base}/blog-posts`))
      .then((data) => { if (!cancelled) setAvailable(data?.available === true); })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, [base, request]);
  const search = useCallback((query) => request(`${base}/blog-posts?q=${encodeURIComponent(query)}`), [base, request]);
  return { available, search };
}

function BlogPostOption({ post, pressed = false, locked, onPick }) {
  return (
    <Button type="button" variant="secondary" className="tech-visit-action tech-visit-tip" aria-pressed={pressed} disabled={locked} onClick={onPick}>
      <span>
        {post.title}
        <span className="tech-visit-tip-copy">{blogPostPath(post.url)}</span>
      </span>
    </Button>
  );
}

// One Waves blog post for the customer, searched the way Quick Links searches
// links. It goes at the bottom of their report as "From the Waves blog".
// Optional; the server checks the pick is still live when the visit completes.
export function BlogPostSection({ search, value, locked, onChange }) {
  // The search's coverage and "Suggest a post" belong to the office form only
  // (owner 2026-10-03: the tech screen is going away and new work goes to the
  // admin UI), so this sheet keeps the plain list it had.
  const { query, setQuery, results, status } = useBlogPostSearch(search);
  return (
    <section className="tech-visit-choice-section" aria-label="Blog post for the customer">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Blog post for the customer</h3>
        <span className="tech-visit-muted">{value ? '1 picked' : 'Pick 1 (optional)'}</span>
      </div>
      {value ? (
        <>
          <div className="tech-visit-tip-list">
            <BlogPostOption post={value} pressed locked={locked} onPick={() => onChange(null)} />
          </div>
          <div className="tech-visit-tile-grid">
            <Chip disabled={locked} label="Remove" onClick={() => onChange(null)} />
          </div>
        </>
      ) : (
        <>
          <Field label="Search the Waves blog" className="tech-visit-field">
            <Input className="tech-visit-control" type="search" value={query} disabled={locked} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. ghost ants" />
          </Field>
          <div className="tech-visit-tip-list">
            {results.map((post) => <BlogPostOption key={post.id} post={post} locked={locked} onPick={() => onChange(post)} />)}
            {status === 'searching' && <p className="tech-visit-muted">Searching…</p>}
            {status === 'failed' && <p className="tech-visit-muted">The blog search didn’t answer. Try again.</p>}
            {status === 'done' && !results.length && <p className="tech-visit-muted">No live posts match.</p>}
          </div>
        </>
      )}
    </section>
  );
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
// The visit's saved trace. A read that failed is not "no trace": failed holds
// the send (a saved perimeter would still show on the customer's report)
// until reload reads it again.
export function useVisitTrace({ serviceId, request }) {
  const [state, setState] = useState({ loaded: false, failed: false, enabled: false, zone: null });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loaded: false, failed: false }));
    request(`/tech/services/${serviceId}/treatment-zone`)
      .then((data) => {
        if (!cancelled) setState({ loaded: true, failed: false, enabled: data?.enabled === true, zone: data?.treatmentZone || null });
      })
      .catch(() => { if (!cancelled) setState({ loaded: true, failed: true, enabled: false, zone: null }); });
    return () => { cancelled = true; };
  }, [request, serviceId, reads]);
  const saved = useCallback((zone) => setState((prev) => ({ ...prev, zone: zone || prev.zone })), []);
  const reload = useCallback(() => setReads((n) => n + 1), []);
  return { ...state, saved, reload };
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
  // A spray heard but not held up: never recorded as spot spraying.
  if (facts.unclearSpray) {
    return 'It isn’t clear how you sprayed. Say plainly whether you sprayed around the house, sprayed spots, or didn’t spray, then write it again.';
  }
  // A pest the note treats for that was not heard: never left off the
  // products' targets (Codex #5538).
  const unclearPests = facts.unclearPests || [];
  if (unclearPests.length) {
    return `It isn’t clear whether you treated for ${joinAnd(unclearPests)}. Say plainly which pests you treated for, then write it again.`;
  }
  if (!facts.areas.length) return 'Say where you treated (inside, outside or garage) in your note, then write it again.';
  // Every product goes on the record with the pests it was for, as the
  // re-service sheet requires a pest; none heard means none would be recorded.
  return facts.pests?.length ? '' : 'Say what pest you treated for (ants, roaches, spiders…) in your note, then write it again.';
}

const SPRAY_HEARD = { perimeter: 'perimeter spray', spot: 'spot spraying' };

function HeardLine({ facts }) {
  if (!FACTS_READ.has(facts?.status)) return null;
  const unclear = facts.unclearAreas || [];
  const heard = [
    facts.areas.length ? `treated ${joinAnd(facts.areas.map((area) => area.toLowerCase()))}` : (unclear.length ? '' : 'where you treated: not heard'),
    unclear.length ? `not clear: ${joinAnd(unclear.map((area) => area.toLowerCase()))}` : '',
    SPRAY_HEARD[facts.spray] || (facts.unclearSpray ? 'not clear: how you sprayed' : '') || (facts.noSpray ? 'no spraying' : ''),
    facts.pests.length ? `for ${facts.pests.join(', ')}` : '',
    (facts.unclearPests || []).length ? `not clear: whether for ${joinAnd(facts.unclearPests)}` : '',
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

// Lane voice fill (GATE_LANE_VOICE_FILL, Fast Complete step 2): a specialty
// visit's own record, its places and one value per finding group, as the note
// filled it and the tech confirmed it. A read fills only what is still empty
// and nobody picked; Change is the tech's own pick and the words it came from
// no longer show beside it. The report and the completion are written from
// this record.
export const EMPTY_LANE_RECORD = Object.freeze({ areas: [], values: {}, heard: { areas: {}, values: {} }, picked: [] });
const LANE_TITLES = {
  bed_bug_treatment: 'Bed bug',
  fire_ant: 'Fire ant',
  tick_control: 'Tick',
  bee_wasp_removal: 'Bee & wasp',
  mud_dauber_removal: 'Mud dauber',
  mosquito: 'Mosquito',
};

// The record after a read (the lane reader's answer): the areas while none
// are set or picked, and a group's value when the group is empty, nobody
// picked it, and the value sits with what is chosen by the tap's own rule (a
// value that would drop a chosen one stays unpicked).
export function mergeLaneRecord(record, facts, preset) {
  if (facts?.status !== 'read' || !preset) return record;
  const picked = new Set(record.picked);
  const fillAreas = !record.areas.length && !picked.has('areas');
  const areas = fillAreas ? facts.areas.filter((entry) => preset.areas.includes(entry.area)) : [];
  const values = { ...record.values };
  const heardValues = { ...record.heard.values };
  for (const finding of facts.findings) {
    const group = preset.findingGroups.find((item) => (
      item.key === finding.group && item.options.some((option) => option.value === finding.value)
    ));
    if (!group || values[group.key] || picked.has(group.key)) continue;
    const chosen = Object.values(values);
    if (chosen.every((value) => reconcileDependentFindingSelections(preset, chosen, group, finding.value).includes(value))) {
      values[group.key] = finding.value;
      heardValues[group.key] = { value: finding.value, quote: finding.quote };
    }
  }
  return {
    ...record,
    areas: fillAreas ? areas.map((entry) => entry.area) : record.areas,
    values,
    heard: {
      areas: fillAreas ? Object.fromEntries(areas.map((entry) => [entry.area, entry.quote])) : record.heard.areas,
      values: heardValues,
    },
  };
}

// The tech's own pick: a place toggled, or a group's value set (or cleared,
// ''), the tap's rule dropping a value it excludes.
// The tech's own pick drops the words a fill stood on: a toggled place's,
// the edited group's, and those of a value the pick reconciled away, so
// picking the filled value again shows no quote as if the note had just said
// it (Codex P2 r3 on #5632, the typed record's rule).
export function changeLaneRecord(record, key, value, preset) {
  const picked = [...new Set([...record.picked, key])];
  if (key === 'areas') {
    const areas = record.areas.includes(value) ? record.areas.filter((area) => area !== value) : [...record.areas, value];
    const heardAreas = Object.fromEntries(Object.entries(record.heard.areas).filter(([area]) => area !== value));
    return { ...record, areas, picked, heard: { ...record.heard, areas: heardAreas } };
  }
  const group = preset.findingGroups.find((item) => item.key === key);
  const kept = reconcileDependentFindingSelections(preset, Object.values(record.values), group, value);
  const values = Object.fromEntries(preset.findingGroups
    .map((item) => [item.key, item.options.find((option) => kept.includes(option.value))?.value || ''])
    .filter(([, chosen]) => chosen));
  const heardValues = Object.fromEntries(Object.entries(record.heard.values)
    .filter(([groupKey, entry]) => groupKey !== key && values[groupKey] === entry.value));
  return { ...record, values, picked, heard: { ...record.heard, values: heardValues } };
}

// Whether the completion would refuse this record without an action beside
// it: a lane whose closeout defines its work state takes a completed-work
// finding only with the work performed (specialtyCompletedWorkWithoutAction,
// the client mirror of the server's rule), and the sheet records no actions.
// None of the six voice lanes defines a work state today.
export const laneRecordNeedsAction = (preset, record) => !!specialtyCompletedWorkWithoutAction(preset, Object.values(record.values), []);

// "<Lane> record heard from you": each field with what was heard and a
// Change; a group the note left unclear asks to be picked.
export function LaneRecordCard({ lane, preset, record, unclear = [], readFailed = false, locked, onChange }) {
  const [open, setOpen] = useState(null);
  const titleId = useId();
  const areaQuotes = [...new Set(record.areas.map((area) => record.heard.areas[area]).filter(Boolean))];
  const rows = [
    { key: 'areas', label: 'Where', value: record.areas.join(' · '), quotes: areaQuotes, options: preset.areas, multi: true },
    ...preset.findingGroups.map((group) => {
      const heard = record.heard.values[group.key];
      return {
        key: group.key,
        label: group.label,
        value: record.values[group.key] || '',
        quotes: heard && heard.value === record.values[group.key] ? [heard.quote] : [],
        options: group.options.map((option) => option.value),
      };
    }),
  ];
  return (
    <section className="tech-visit-card tech-lane-record" aria-labelledby={titleId}>
      <h3 id={titleId} className="tech-visit-section-title">{`${LANE_TITLES[lane] || 'Visit'} record heard from you`}</h3>
      {readFailed && <p className="tech-visit-muted tech-visit-status--warn" role="status">Couldn’t read your note for this just now. Pick each one, or write the report again.</p>}
      {rows.map((row) => (
        <div key={row.key} className="tech-lane-row">
          <div className="tech-visit-section-head">
            <span className="tech-lane-label">{row.label}</span>
            <Button
              type="button"
              variant="ghost"
              className="tech-visit-action"
              aria-expanded={open === row.key}
              aria-label={`Change ${row.label}`}
              disabled={locked}
              onClick={() => setOpen(open === row.key ? null : row.key)}
            >
              Change
            </Button>
          </div>
          {row.value ? <p className="tech-lane-value">{row.value}</p> : (
            <p className={cn('tech-lane-value tech-lane-value--empty', unclear.includes(row.key) && 'tech-visit-status--warn')}>
              {unclear.includes(row.key) ? 'Not clear from your note. Pick one.' : (readFailed ? 'Not picked' : 'Not said')}
            </p>
          )}
          {row.quotes.length > 0 && <p className="tech-visit-muted">{row.quotes.map((quote) => `“${quote}”`).join(' · ')}</p>}
          {open === row.key && (
            <div className="tech-visit-tile-grid" role="group" aria-label={row.label}>
              {row.options.map((option) => (
                <Chip
                  key={option}
                  label={option}
                  disabled={locked}
                  pressed={row.multi ? record.areas.includes(option) : row.value === option}
                  onClick={() => {
                    onChange(row.key, row.multi || row.value !== option ? option : '');
                    // One value per finding: the pick is the answer. Places
                    // take several, so their list stays open.
                    if (!row.multi) setOpen(null);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// Typed voice fill (GATE_TYPED_VOICE_FILL, Fast Complete step 3): a typed
// visit's own record, its typed form's values as the note filled them and
// the tech confirmed them, with the activity score for a form whose score
// the tech sets. A read fills only a field still empty that nobody picked
// (the server judged each fill beside the record's values); Change is the
// tech's own pick and the words it came from no longer show beside it.
export const EMPTY_TYPED_RECORD = Object.freeze({ values: {}, heard: {}, picked: [], score: null, heardScore: null });

// The fields the card shows, as the office form shows them: never one
// filled from the products (autoFilled) or a companion's. A pesticide
// compliance field (pesticideOnly) is left to the completion, which refuses
// a visit that needs it, as the office form's own note says.
export const typedCardFields = (schema) => (schema?.fields || []).filter((field) => !field.autoFilled && !field.pesticideOnly && !field.companionOnly);

// The form's activity score is the tech's to set (no field derives it).
export const typedScoreIsTechs = (schema) => !!schema?.activity && !schema.activity.deriveField;

export function mergeTypedRecord(record, facts) {
  if (facts?.status !== 'read') return record;
  const picked = new Set(record.picked);
  const values = { ...record.values };
  const heard = { ...record.heard };
  for (const [key, value] of Object.entries(facts.values || {})) {
    if (typeof value !== 'string' || !value || picked.has(key) || String(values[key] ?? '').trim()) continue;
    values[key] = value;
    // One quote per words heard: two values said in the same words show them once.
    heard[key] = { value, quotes: [...new Set((facts.heard?.[key] || []).map((entry) => entry?.quote).filter(Boolean))] };
  }
  // The technician's own rating, heard on a form whose score they set
  // (step 4), fills only while they have set none.
  const heardScore = Number.isInteger(facts.score?.value) && record.score == null && !picked.has('score')
    ? { value: facts.score.value, quote: facts.score.quote }
    : null;
  return { ...record, values, heard, ...(heardScore ? { score: heardScore.value, heardScore } : {}) };
}

// The tech's own rating (or none): the words a heard rating stood on go.
export const scoreTypedRecord = (record, score) => ({ ...record, score, heardScore: null, picked: [...new Set([...record.picked, 'score'])] });

// The tech's own pick: a field set, or cleared (''). The words a fill stood
// on go with it, even when the filled value is picked again (Codex P2 r3 on
// #5632, the office form's same rule).
export function changeTypedRecord(record, key, value) {
  const values = { ...record.values };
  if (value === '' || value == null) delete values[key];
  else values[key] = value;
  const heard = { ...record.heard };
  delete heard[key];
  return { ...record, values, heard, picked: [...new Set([...record.picked, key])] };
}

// A chips field's value is its picked options joined ", " in the form's own
// order, as the full form stores it.
function toggleChip(field, current, option) {
  const chosen = new Set(String(current || '').split(',').map((part) => part.trim()).filter(Boolean));
  if (chosen.has(option)) chosen.delete(option);
  else chosen.add(option);
  return field.options.filter((item) => chosen.has(item)).join(', ');
}

function TypedRecordRow({ schemaType, field, record, unclear, readFailed, locked, open, onOpen, onChange }) {
  const value = record.values[field.key] ?? '';
  const required = typedFieldRequiredNow(field, record.values);
  const heard = record.heard[field.key];
  const quotes = heard && heard.value === value ? heard.quotes : [];
  const name = typedFieldLabel(schemaType, field, record.values);
  const label = `${name}${required ? ' (required)' : ''}`;
  const heardLine = quotes.length > 0 && <p className="tech-visit-muted">{quotes.map((quote) => `“${quote}”`).join(' · ')}</p>;
  if (field.type === 'text' || field.type === 'count') {
    return (
      <div className="tech-lane-row">
        <Field label={label} className="tech-visit-field">
          <Input
            className="tech-visit-control"
            value={value}
            disabled={locked}
            {...(field.type === 'count' ? { inputMode: 'numeric', pattern: '[0-9]*', maxLength: 4 } : {})}
            onChange={(event) => onChange(field.key, field.type === 'count' ? event.target.value.replace(/\D/g, '').slice(0, 4) : event.target.value)}
          />
        </Field>
        {!value && unclear.includes(field.key) && <p className="tech-visit-muted tech-visit-status--warn">Not clear from your note. Enter the number.</p>}
        {heardLine}
      </div>
    );
  }
  const ask = field.type === 'chips' ? 'Not clear from your note. Pick what applies.' : 'Not clear from your note. Pick one.';
  let shown = <p className="tech-lane-value tech-lane-value--empty">{readFailed ? 'Not picked' : 'Not said'}</p>;
  if (value) shown = <p className="tech-lane-value">{value}</p>;
  else if (unclear.includes(field.key)) shown = <p className="tech-lane-value tech-lane-value--empty tech-visit-status--warn">{ask}</p>;
  return (
    <div className="tech-lane-row">
      <div className="tech-visit-section-head">
        <span className="tech-lane-label">{label}</span>
        <Button type="button" variant="ghost" className="tech-visit-action" aria-expanded={open} aria-label={`Change ${field.label}`} disabled={locked} onClick={onOpen}>
          Change
        </Button>
      </div>
      {shown}
      {heardLine}
      {open && (
        <div className="tech-visit-tile-grid" role="group" aria-label={field.label}>
          {field.options.map((option) => {
            const pressed = field.type === 'chips'
              ? String(value).split(',').map((part) => part.trim()).includes(option)
              : value === option;
            return (
              <Chip
                key={option}
                label={option}
                disabled={locked}
                pressed={pressed}
                onClick={() => onChange(field.key, field.type === 'chips' ? toggleChip(field, value, option) : (pressed ? '' : option), field.type !== 'chips')}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// "<Form> record heard from you": the typed form's fields with what was
// heard, a Change (or a box for a count or free text), the optional ones
// behind "More detail" unless they hold a value, are required now or the
// note left them unclear, and the activity score when it is the tech's.
export function TypedRecordCard({ schema, record, unclear = [], scoreUnclear = false, readFailed = false, locked, onChange, onScore }) {
  const [open, setOpen] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const titleId = useId();
  const fields = typedCardFields(schema);
  const primary = (field) => !field.detail || typedFieldRequiredNow(field, record.values)
    || String(record.values[field.key] ?? '').trim() !== '' || unclear.includes(field.key);
  const hidden = fields.filter((field) => !primary(field)).length;
  const scoreLabels = schema?.activity?.techScoreLabels || {};
  return (
    <section className="tech-visit-card tech-lane-record" aria-labelledby={titleId}>
      <h3 id={titleId} className="tech-visit-section-title">{`${schema?.label || 'Visit'} record heard from you`}</h3>
      {readFailed && <p className="tech-visit-muted tech-visit-status--warn" role="status">Couldn’t read your note for this just now. Pick each one, or write the report again.</p>}
      {fields.filter((field) => showDetail || primary(field)).map((field) => (
        <TypedRecordRow
          key={field.key}
          schemaType={schema?.type}
          field={field}
          record={record}
          unclear={unclear}
          readFailed={readFailed}
          locked={locked}
          open={open === field.key}
          onOpen={() => setOpen(open === field.key ? null : field.key)}
          onChange={(key, value, closes) => {
            onChange(key, value);
            if (closes) setOpen(null);
          }}
        />
      ))}
      {!showDetail && hidden > 0 && (
        <Button type="button" variant="ghost" className="tech-visit-action" disabled={locked} onClick={() => setShowDetail(true)}>
          {`More detail (${hidden})`}
        </Button>
      )}
      {typedScoreIsTechs(schema) && (
        <div className="tech-lane-row">
          <span className="tech-lane-label">{`${schema.activity.label || 'Activity'} (required)`}</span>
          <div className="tech-visit-tile-grid" role="group" aria-label={schema.activity.label || 'Activity'}>
            {[0, 1, 2, 3, 4, 5].map((score) => (
              <Chip
                key={score}
                label={scoreLabels[score] ? `${score} ${scoreLabels[score]}` : String(score)}
                disabled={locked}
                pressed={record.score === score}
                onClick={() => onScore(record.score === score ? null : score)}
              />
            ))}
          </div>
          {record.score == null && scoreUnclear && <p className="tech-visit-muted tech-visit-status--warn">Not clear from your note. Pick one.</p>}
          {record.heardScore && record.heardScore.value === record.score && <p className="tech-visit-muted">{`“${record.heardScore.quote}”`}</p>}
        </div>
      )}
    </section>
  );
}

export function ReportCard({
  draft, editing, stale, locked, photoCount, traced, blogPost, pestHeard = true, onEdit, onDoneEditing, onChangeText, onWriteAgain,
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
      {blogPost && <p className="tech-visit-muted">At the bottom, from the Waves blog: {blogPost.title}</p>}
      {pestHeard && <HeardLine facts={draft.facts} />}
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
// What became of the report message, from the completion's own status and
// reason: a held, blocked or failed message says so, never silence.
// The status is the text or app message only: a customer who prefers the app
// gets it there, so a sent message never says "text", and the report email
// goes out on its own, so a message that did not go never says nothing went.
const SMS_RESULT = {
  sent: () => 'The report went to the customer.',
  sending: () => 'The report is on its way to the customer.',
  deferred: () => 'The report is queued and goes out in the customer’s messaging hours.',
  no_phone: () => 'No phone on file, so no text or app message went out. The report is in the customer’s portal.',
  skipped_recap_sms_already_sent: () => 'A message already went to the customer for this visit.',
  suppressed_delivery_mode: () => 'Nothing was sent: this visit’s report is not sent to customers.',
  blocked: (reason) => `No text or app message went out: ${reason || 'the customer’s message settings held it'}.`,
  failed: (reason) => `The text or app message did not go out${reason ? ` (${reason})` : ''}. The office can resend it.`,
};
function smsLine(result) {
  const status = result?.completionSmsStatus;
  if (!status || status === 'not_requested') return null;
  const reason = String(result.completionSmsError || '').trim();
  return SMS_RESULT[status]?.(reason) || `No text or app message went to the customer${reason ? `: ${reason}` : ''}.`;
}

// An invoice settled by the annual prepay keeps its total (status
// 'prepaid'), so it is settled, never shown as due or collected.
const SETTLED_BILL = { paid: 'Bill: paid.', prepaid: 'Bill: covered by the annual prepay.', processing: 'Bill: payment processing.' };

function billLine(result) {
  if (!result?.invoiceId) return null;
  if (SETTLED_BILL[result.invoiceStatus]) return SETTLED_BILL[result.invoiceStatus];
  // invoiceTotal is the amount still due, so a paid bill names no amount.
  const due = Number(result.invoiceTotal);
  if (!(result.invoiceTotal != null && Number.isFinite(due) && due > 0)) return null;
  // A third-party Bill-To invoice is the payer's to pay, never collected from
  // the customer at the door. Who owes it, not whether it went: an AP email
  // can fail and statement payers get it on their statement.
  return result.invoicePayerBilled === true ? `Bill: ${money(due)}, billed to the payer on file.` : `Bill: ${money(due)} due.`;
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
// which promises are off the customer's open list. Off the list is not proof
// the completion closed one (the office may have moved it to another
// customer), so it never says "closed".
export function SentSummary({ result, doneMarks = [], base, request, followupBooking = false }) {
  const open = usePromisesStillOpen({ base, request, ids: doneMarks.map((mark) => String(mark.id)) });
  if (!result) return null;
  const lines = [smsLine(result), billLine(result)].filter(Boolean);
  return (
    <div data-testid="fast-complete-sent">
      {lines.map((line) => <p key={line} className="tech-visit-muted">{line}</p>)}
      {open && doneMarks.map((mark) => (
        <p key={mark.id} className="tech-visit-muted">
          {open.has(String(mark.id)) ? `Still open: ${mark.description}. The office will settle it.` : `Off the customer’s open list: ${mark.description}`}
        </p>
      ))}
      {followupBooking && <FollowupBooking suggestion={result.followupSuggestion} base={base} request={request} />}
    </div>
  );
}

// "Thursday, October 15", a follow-up's ET calendar day.
const followupDay = (date) => formatETDateOnly(date, { weekday: 'long', month: 'long', day: 'numeric' });

// The follow-up a completion suggests (GATE_TYPED_VOICE_FILL, step 3 "after
// sending": bed bug, flea, cockroach and the knockdowns), booked in one tap
// on its suggested day as a pending visit, the office's Schedule follow-up
// (POST /admin/dispatch/:id/schedule-followup; the server re-derives the
// suggestion and books it once per visit). No suggestion, nothing shown.
export function FollowupBooking({ suggestion, base, request }) {
  const [state, setState] = useState({ status: 'idle', message: '' });
  if (!suggestion?.required || !suggestion.suggestedDate) return null;
  const days = Number.isFinite(Number(suggestion.days)) && Number(suggestion.days) > 0 ? ` (${Number(suggestion.days)} days)` : '';
  const book = async () => {
    setState({ status: 'booking', message: '' });
    try {
      const answer = await request(`${base}/schedule-followup`, { method: 'POST', body: JSON.stringify({ date: suggestion.suggestedDate }) });
      const day = followupDay(answer?.appointment?.scheduledDate || suggestion.suggestedDate);
      setState({
        status: 'booked',
        message: answer?.alreadyScheduled
          ? `A follow-up is already on the books for ${day}.`
          : `Follow-up booked for ${day}. It stays pending until the office confirms it.`,
      });
    } catch (err) {
      setState({ status: 'failed', message: `${err?.message || 'The follow-up could not be booked.'} Try again.` });
    }
  };
  return (
    <div data-testid="fast-complete-followup">
      <p className="tech-visit-muted">{`Follow-up suggested: ${followupDay(suggestion.suggestedDate)}${days}`}</p>
      {state.status === 'booked'
        ? <p className="tech-visit-muted" role="status">{state.message}</p>
        : (
          <>
            {state.status === 'failed' && <p className="tech-visit-muted tech-visit-status--warn" role="status">{state.message}</p>}
            <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={state.status === 'booking'} onClick={book}>
              Book the follow-up
            </Button>
          </>
        )}
    </div>
  );
}

// The inspection credit a typed inspection offers (the office form's
// "Credit this inspection toward booked service"), on unless the tech turns
// it off. The window is the service's own, so no number is named here.
export function InspectionCreditToggle({ checked, locked, onChange }) {
  return (
    <section className="tech-visit-card" aria-label="Inspection credit">
      <Button type="button" variant="secondary" className="tech-visit-action tech-visit-tip" aria-pressed={checked} disabled={locked} onClick={() => onChange(!checked)}>
        Credit this inspection toward booked service
      </Button>
      <p className="tech-visit-muted">Applies as account credit only if they book. Nothing is credited now.</p>
    </section>
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
    && result?.invoicePaymentActionRequired !== false && !SETTLED_BILL[result?.invoiceStatus];
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
