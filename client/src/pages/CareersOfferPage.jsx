/**
 * <CareersOfferPage> — /careers/offer/:token
 *
 * Public, token-gated job offer page. An applicant the owner sent an offer to
 * gets this link by text + email, reads the offer and the Technician Terms,
 * and signs by typing a full name, asks for another start date, or declines.
 *
 * Modeled on CareersInterviewPage.jsx: WavesShell wraps this page at the route
 * (App.jsx), terminal states use PublicStateCard / PublicLoadError, and every
 * request goes to `${API_BASE}/public/careers/offer/:token`.
 *
 * Dates are never re-derived from "now" for display: startDate, stepEffectiveOn
 * and sentOn are date values and are formatted without a time-zone shift;
 * expiresAt and signedAt are instants and are formatted in Eastern time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import {
  CustomerColumn,
  BrandCard,
  BrandButton,
  PublicStateCard,
} from '../components/brand';
import PublicLoadError from '../components/PublicLoadError';
import SafeMarkdown from '../components/SafeMarkdown';
import { useGlassSurface } from '../glass/glass-engine';
import {
  dateRequestProblem,
  formatExpiry,
  formatLongDate,
  formatLongInstant,
  formatSentOn,
  hasOfferFacts,
  payLine,
  signedNameValid,
  tomorrowET,
} from '../components/careers/offerFormat';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const TEXT = COLORS.glassNavy;
// slate-600, not the caption slate-500: the glass backdrop drops slate-500 under 4.5:1.
const MUTED = '#475569';
const NOTE_MAX = 500;

const EYEBROW = {
  fontFamily: FONTS.ui,
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: TEXT,
  marginBottom: 6,
};

const H1_STYLE = {
  margin: '0 0 6px',
  fontFamily: FONTS.heading,
  fontSize: 26,
  fontWeight: 700,
  color: TEXT,
  lineHeight: 1.2,
};

const BODY_STYLE = {
  margin: 0,
  fontFamily: FONTS.body,
  fontSize: 16,
  lineHeight: 1.55,
  color: 'var(--text-subtle, #475569)',
};

const FIELD_STYLE = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 44,
  padding: '10px 12px',
  border: '1px solid var(--border-strong, #C7D7E2)',
  borderRadius: 'var(--radius-md, 10px)',
  background: 'var(--surface, #FFFFFF)',
  color: TEXT,
  fontFamily: FONTS.body,
  fontSize: 16,
};

const LABEL_STYLE = {
  display: 'block',
  margin: '0 0 6px',
  fontFamily: FONTS.ui,
  fontSize: 14,
  fontWeight: 700,
  color: TEXT,
};

const ERROR_BANNER_STYLE = {
  marginTop: 14,
  padding: '10px 12px',
  border: '1px solid #FECACA',
  background: '#FEF2F2',
  color: '#991B1B',
  borderRadius: 'var(--radius-md, 10px)',
  fontSize: 14,
  lineHeight: 1.5,
};

const REFRESH_ERROR = 'We could not refresh this offer. Check your connection and try again.';
const NOT_SAVED_ERROR = 'That did not go through. Please try again.';
// This page and the server do not match (OfferPage `outdated`): trying again cannot help,
// and a reload loads the page the server serves now.
const OUTDATED_ERROR = 'This page is out of date. Please reload it and try again.';
const CONNECTION_ERROR = 'Could not save that. Check your connection and try again.';
// A send whose reply was lost: it may still go through, so it is not called failed.
const LOST_ERROR = 'We could not confirm that. Check your connection and try again.';

function ownerFirstName(data) {
  const first = String(data.owner?.name || '').trim().split(/\s+/)[0];
  return first || 'Adam';
}

// ── Network ───────────────────────────────────────────────────────────────

function offerUrl(token, suffix = '') {
  return `${API_BASE}/public/careers/offer/${encodeURIComponent(token)}${suffix}`;
}

// A reply that cannot be read is not a failure: the write may have committed.
// Only a non-OK status is a clean refusal; a lost or unreadable OK reply throws
// so the caller re-reads the offer. Every answer goes to the /v2 routes, which
// check the version it carries; a server from before the version has none, so
// in a mixed deploy or a rollback the answer gets a 404 and writes nothing.
async function postJson(token, suffix, payload) {
  const res = await fetch(offerUrl(token, `/v2${suffix}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = res.ok ? await res.json() : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Keeps the applicant's page in the robots-out, no-referrer shape the server
// also sends as headers: the URL is a private bearer link.
function usePrivatePage() {
  useEffect(() => {
    const added = [];
    const add = (name, content) => {
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      added.push(meta);
    };
    add('robots', 'noindex, nofollow, noarchive');
    add('referrer', 'no-referrer');
    return () => added.forEach((meta) => meta.remove());
  }, []);
}

// ── Pieces ────────────────────────────────────────────────────────────────

function Column({ children }) {
  return <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>{children}</CustomerColumn>;
}

function LoadingState() {
  return (
    <Column>
      <BrandCard padding={28}>
        <div style={{ padding: '40px 20px', textAlign: 'center', color: MUTED, fontSize: 16 }}>Loading…</div>
      </BrandCard>
    </Column>
  );
}

function NotValidState() {
  return (
    <Column>
      <PublicStateCard state="not-found" title="This link is not valid." contact="none">
        Please check the link in your text or email.
      </PublicStateCard>
    </Column>
  );
}

const CLOSED_FALLBACK = {
  expired: 'This offer is closed. Please call Adam if you still want the job.',
  withdrawn: 'This offer is no longer open. Please call Adam.',
  superseded: 'This offer was updated. Please use the newest link Adam sent you.',
};

// '(941) 297-5749' or '+19412975749' -> 'tel:+19412975749'.
function telHref(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const e164 = digits.length === 10 ? `1${digits}` : digits;
  return `tel:+${e164}`;
}

// expired / withdrawn / superseded: the message and the phone number only.
function ClosedState({ data }) {
  const phone = data.contactPhone || WAVES_SUPPORT_PHONE_DISPLAY;
  const tel = data.contactPhone ? telHref(data.contactPhone) : WAVES_SUPPORT_PHONE_TEL;
  return (
    <Column>
      <PublicStateCard state="expired" title="Your job offer" contact="none">
        <p style={{ margin: 0 }}>{data.message || CLOSED_FALLBACK[data.state]}</p>
        <p style={{ margin: '12px 0 0' }}>
          <a href={tel} style={{ color: 'inherit', fontWeight: 700, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
            {phone}
          </a>
        </p>
      </PublicStateCard>
    </Column>
  );
}

// own: this tab's own action got this answer from the server (a 200 to its
// sign, date request or decline; a sign answered as a replay is not its own).
// Only then is it told in the first person, in the words the owner approved.
// Any other answer (a page opened on it, or one learned from a 409 or a read:
// another tab, or a send whose reply was lost) may not be the reader's doing,
// so it is told in neutral words that name the signer and the date.
function resultMessage(data, own) {
  const who = ownerFirstName(data);
  if (data.state === 'signed') {
    const when = formatLongInstant(data.signedAt);
    const lead = own ? 'You signed this offer' : `This offer was signed${data.signedName ? ` by ${data.signedName}` : ''}`;
    return `${lead}${when ? ` on ${when}` : ''}. Welcome to Waves. ${who} will contact you about your first day.`;
  }
  if (data.state === 'date_requested') {
    return own
      ? `Thanks. ${who} will look at your new date. If it works, he will send you an updated offer.`
      : `${who} will look at the new date. If it works, he will send an updated offer.`;
  }
  return own ? 'You declined this offer. Thank you for your time.' : 'This offer was declined. Thank you for your time.';
}

// signed / declined / date_requested: the answer given (see resultMessage).
function ResultState({ data, own }) {
  return (
    <Column>
      <div style={EYEBROW}>Waves</div>
      <h1 style={H1_STYLE}>Your job offer</h1>
      <BrandCard padding={24}>
        {data.state === 'date_requested' && data.requestedStartDate && (
          <p style={{ ...BODY_STYLE, marginBottom: 10, fontWeight: 700, color: TEXT }}>
            {own ? 'You asked to start on' : 'A new start date was asked for:'} {formatLongDate(data.requestedStartDate)}.
          </p>
        )}
        <p style={BODY_STYLE} role="status">{resultMessage(data, own)}</p>
      </BrandCard>
    </Column>
  );
}

function OfferRow({ label, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderTop: '1px solid var(--border, #E2E8F0)' }}>
      <div style={{ flex: '0 0 92px', fontFamily: FONTS.ui, fontSize: 14, fontWeight: 700, color: MUTED }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0, fontFamily: FONTS.body, fontSize: 16, color: TEXT, overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </div>
  );
}

function OfferSummary({ data }) {
  const rows = [
    ['Job', data.jobTitle],
    ['Start', formatLongDate(data.startDate)],
    ['Pay', payLine(data)],
    ['Week', data.hoursLine],
    ['Reports to', data.reportTo],
    ['Pay day', data.payDayLine],
  ];
  return (
    <div style={{ marginTop: 14 }}>
      {rows.map(([label, value]) => <OfferRow key={label} label={label}>{value}</OfferRow>)}
    </div>
  );
}

function TermsSection({ terms }) {
  const [open, setOpen] = useState(false);
  if (!terms?.markdown) return null;
  return (
    <div style={{ borderTop: '1px solid var(--border, #E2E8F0)', padding: '4px 0' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          minHeight: 44,
          padding: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--brand, #04395E)',
          fontFamily: FONTS.ui,
          fontSize: 16,
          fontWeight: 700,
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span>{open ? 'Hide the Technician Terms' : 'Read the Technician Terms'}</span>
        <span aria-hidden="true">{open ? '↑' : '→'}</span>
      </button>
      {open && (
        <div data-testid="offer-terms" style={{ padding: '4px 0 12px' }}>
          {terms.title && <div style={{ ...LABEL_STYLE, marginTop: 8 }}>{terms.title}</div>}
          <SafeMarkdown markdown={terms.markdown} />
        </div>
      )}
    </div>
  );
}

function TextConsent({ token, initial, version, onPending, onStale, onSnapshot, onRefused, onInvalid, locked }) {
  const [checked, setChecked] = useState(Boolean(initial));
  // The offer's version the choice is made on: the page's copy, which each
  // read and each save brings up to date. The server refuses a change made
  // from an older version, so a save that lands late (Try again sent the
  // choice again meanwhile) cannot undo a later choice.
  const versionRef = useRef(version);
  const [saving, setSaving] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState('');
  // The choice the applicant just made, while its save has no answer yet. It
  // survives a failed read, and Try again sends it again.
  const wanted = useRef(null);
  // True once a save of that choice lost its reply: it may still land, so a
  // later refusal (a 429, say) says nothing about what is stored.
  const lostSave = useRef(false);
  // A change the server refused (409) while the offer could not be read
  // after it. The read that Try again makes says the change did not go
  // through when the stored choice is not this one.
  const refused = useRef(null);

  // A fresh read of the offer (another tab changed the choice, or an action
  // re-read the offer) carries the stored choice. Show it, unless a choice
  // made here is still waiting for its answer.
  useEffect(() => {
    if (wanted.current !== null) return;
    setChecked(Boolean(initial));
    versionRef.current = version;
  }, [initial, version]);

  // After a write whose reply was lost, ask the server what it stored. Signing
  // stays locked until the stored choice is the one the applicant made. The read
  // can run before the lost save commits, so a read of the other value keeps the
  // choice and the lock, and Try again sends the same choice again (setting it
  // twice changes nothing).
  const confirm = async () => {
    setSaving(true);
    onPending(true);
    try {
      const body = await readOffer(token);
      const stored = Boolean(body.textConsent);
      if (body.state === 'open' && wanted.current !== null && stored !== wanted.current) {
        setUnconfirmed(true);
        return;
      }
      const notSaved = body.state === 'open' && refused.current !== null && stored !== refused.current;
      wanted.current = null;
      refused.current = null;
      lostSave.current = false;
      setChecked(stored);
      setUnconfirmed(false);
      setError(notSaved ? NOT_SAVED_ERROR : '');
      onPending(false);
      onSnapshot(body);
    } catch (err) {
      if (err.notFound) onInvalid();
      else setUnconfirmed(true);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (next) => {
    wanted.current = next;
    refused.current = null;
    setChecked(next);
    setSaving(true);
    onPending(true);
    setUnconfirmed(false);
    setError('');
    let res;
    try {
      res = await postJson(token, '/text-consent', { consent: next, version: versionRef.current });
    } catch {
      lostSave.current = true;
      await confirm();
      return;
    }
    if (res.status >= 500 || (res.ok && !(hasVersion(res.body) && typeof res.body.textConsent === 'boolean'))) {
      // A gateway error can arrive after the write committed, and a save whose
      // reply lacks the choice or the version cannot be applied: ask the server.
      lostSave.current = true;
      await confirm();
      return;
    }
    if (lostSave.current && !res.ok && res.status !== 409) {
      // Refused, but an earlier save of this choice may still have landed: keep
      // the choice and the lock until a save or a read settles it. A 404 (a
      // server without the /v2 routes, or a dead link) says nothing about that
      // save, so the page reads at once: the read shows a choice that landed,
      // or a dead link, and otherwise keeps the choice and the lock.
      if (res.status === 404) {
        await confirm();
        return;
      }
      setUnconfirmed(true);
      setSaving(false);
      return;
    }
    // A definite answer: the server took the choice or refused it.
    wanted.current = null;
    lostSave.current = false;
    if (res.ok) {
      const stored = Boolean(res.body.textConsent);
      setChecked(stored);
      onSnapshot({ textConsent: stored, version: res.body.version }); // the page's copy follows, so a later read can correct the box
    } else setChecked(!next);
    if (res.status === 404 || res.status === 409) {
      // A 409 says where the offer stands, or the page reads it. A 404 is read
      // again before the link counts as dead, and an open read then marks the
      // page out of date (OfferPage `recheck`).
      const after = res.status === 409 && onRefused(res.body) ? 'changed' : await onStale(res.status);
      if (after === 'failed') {
        // The offer changed but the new state could not be read: stay locked.
        refused.current = next;
        setUnconfirmed(true);
        setSaving(false);
        return;
      }
      // Still open after a 409: the change was made on an older read and refused.
      // The box now shows the stored choice; say so, so no one signs on a choice
      // that was never saved.
      if (after === 'open') setError(NOT_SAVED_ERROR);
    } else if (!res.ok) setError(res.body?.error || CONNECTION_ERROR);
    setSaving(false);
    onPending(false);
  };

  return (
    <div style={{ marginTop: 16 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 44, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={checked}
          disabled={saving || locked || unconfirmed}
          onChange={(e) => toggle(e.target.checked)}
          style={{ width: 24, height: 24, flex: '0 0 auto', accentColor: 'var(--brand, #04395E)' }}
        />
        <span style={{ fontFamily: FONTS.body, fontSize: 16, color: TEXT }}>Text me about this offer</span>
      </label>
      {unconfirmed && (
        <div style={ERROR_BANNER_STYLE} role="alert">
          We could not confirm that choice. Check your connection and try again.
          <div style={{ marginTop: 8 }}>
            <BrandButton variant="secondary" disabled={saving} onClick={() => (wanted.current === null ? confirm() : toggle(wanted.current))}>Try again</BrandButton>
          </div>
        </div>
      )}
      {error && <div style={ERROR_BANNER_STYLE} role="alert">{error}</div>}
    </div>
  );
}

// This page and the server do not match (OfferPage `outdated`). Every answer stays locked;
// a reload loads the page the server serves now. It shows only while no send is unresolved,
// so a reload never drops an answer whose outcome is not known yet.
function OutdatedBanner({ outdated, unresolved }) {
  if (!outdated || unresolved) return null;
  return (
    <div style={ERROR_BANNER_STYLE} role="alert">
      {OUTDATED_ERROR}
      <div style={{ marginTop: 8 }}>
        <BrandButton variant="secondary" onClick={() => window.location.reload()}>Reload page</BrandButton>
      </div>
    </div>
  );
}

function NoteField({ id, label, value, onChange, disabled }) {
  return (
    <div style={{ marginTop: 12 }}>
      <label htmlFor={id} style={LABEL_STYLE}>{label}</label>
      <textarea
        id={id}
        disabled={disabled}
        rows={3}
        maxLength={NOTE_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...FIELD_STYLE, resize: 'vertical' }}
      />
      <div style={{ fontSize: 14, color: MUTED, marginTop: 4 }}>{value.length} of {NOTE_MAX}</div>
    </div>
  );
}

// Shared submit wrapper for the three actions: one in-flight request at a
// time, a 404 means the link is dead, a 409 means the offer changed under the
// applicant (re-read it), a lost response is re-checked before saying failed.
// Each action sends the version of the offer on screen, the text box's choice
// included: a change since then (another tab) is refused with the offer still
// open, so the page reads it again and the applicant answers on what it shows.
function useOfferAction({ token, onApplied, onRefused, onReload, onRecheck, onUnknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The last send whose reply was lost ({ suffix, payload }). It may still go
  // through, so until a resend of it gets a definite answer it is the only
  // thing the applicant can do (a repeat is refused, and its 409 names the
  // answer), and no other action can race it.
  const [lost, setLost] = useState(null);

  const run = useCallback(async (suffix, payload) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await postJson(token, suffix, payload);
      checkDefinite(res, suffix); // a reply that may have committed throws: handled below
      if (lost && !res.ok && res.status !== 409) {
        // Refused before the offer was checked: a 429, a 400, or a 404 from a
        // server without the /v2 routes (a mixed deploy or a rollback) while
        // the lost send may still wait for the offer. The lost send may still
        // land. Keep it the only action, and read in case it has (a 404 read
        // shows a dead link). A 400 refuses the same payload as invalid, so
        // the lost send was refused too or ended long ago (a date that passed
        // at midnight): an open read then frees the fields for a new value.
        if (res.status !== 404) setError(res.body?.error || '');
        const after = await onReload();
        if (res.status === 400 && after === 'open') setLost(null);
        return;
      }
      setLost(null); // a definite answer: a 409, or a 404 with no lost send, wrote nothing
      if (res.status === 404 || res.status === 409) {
        // A 409 says where the offer stands: the page shows it at once, so a
        // failed read cannot leave the old offer on screen. A 404 is read
        // again before the link counts as dead: in a mixed deploy or a
        // rollback, a server without the /v2 routes answers 404 for a live
        // offer, and the read, which every server answers, tells which (an
        // open offer marks the page out of date: OfferPage `recheck`).
        if (res.status === 409 && onRefused(res.body)) return;
        const after = await onRecheck(res.status);
        if (after === 'failed') onUnknown();
        else if (after === 'open') setError(NOT_SAVED_ERROR);
        return;
      }
      if (!res.ok) {
        setError(res.body?.error || 'We could not save that. Please check what you entered and try again.');
        return;
      }
      onApplied(res.body, payload);
    } catch {
      // No answer, a gateway error, or an unreadable reply. A read shows an
      // answer that already landed; otherwise only a resend is offered.
      setLost({ suffix, payload });
      await onReload();
    } finally {
      setBusy(false);
    }
  }, [busy, lost, token, onApplied, onRefused, onReload, onRecheck, onUnknown]);

  const retry = useCallback(() => (lost ? run(lost.suffix, lost.payload) : undefined), [lost, run]);
  // frozen: the send's own fields are fixed while it is in flight or lost, so
  // a resend sends what the applicant sees.
  return { busy, error, setError, run, lost: Boolean(lost), retry, frozen: busy || Boolean(lost) };
}

function LostBanner({ action }) {
  if (!action.lost) return null;
  return (
    <div style={ERROR_BANNER_STYLE} role="alert">
      {LOST_ERROR}
      <div style={{ marginTop: 8 }}>
        <BrandButton variant="secondary" disabled={action.busy} onClick={action.retry}>
          {action.busy ? 'Trying…' : 'Try again'}
        </BrandButton>
      </div>
    </div>
  );
}

function DateRequestPanel({ onSubmit, onCancel, busy, frozen, locked, error }) {
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const problem = dateRequestProblem(date);
  return (
    <div style={{ marginTop: 16, padding: 14, border: '1px solid var(--border-strong, #C7D7E2)', borderRadius: 'var(--radius-md, 10px)' }}>
      <label htmlFor="offer-new-date" style={LABEL_STYLE}>Another start date (Monday to Thursday)</label>
      <input
        id="offer-new-date"
        type="date"
        disabled={frozen}
        min={tomorrowET()}
        value={date}
        onChange={(e) => { setDate(e.target.value); setTouched(true); }}
        style={FIELD_STYLE}
      />
      {touched && problem && <div style={{ ...ERROR_BANNER_STYLE, marginTop: 8 }} role="alert">{problem}</div>}
      <NoteField id="offer-date-note" label="Note (optional)" value={note} onChange={setNote} disabled={frozen} />
      {error && <div style={ERROR_BANNER_STYLE} role="alert">{error}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <BrandButton variant="secondary" disabled={locked} onClick={onCancel}>Cancel</BrandButton>
        <BrandButton
          disabled={locked || Boolean(problem)}
          onClick={() => onSubmit({ requestedStartDate: date, ...(note.trim() ? { note: note.trim() } : {}) })}
        >
          {busy ? 'Sending…' : 'Send this date'}
        </BrandButton>
      </div>
    </div>
  );
}

function DeclinePanel({ onSubmit, onCancel, busy, frozen, locked, error }) {
  const [reason, setReason] = useState('');
  return (
    <div role="group" aria-label="Decline this offer" style={{ marginTop: 16, padding: 14, border: '1px solid var(--border-strong, #C7D7E2)', borderRadius: 'var(--radius-md, 10px)' }}>
      <p style={BODY_STYLE}>Are you sure you want to decline this offer?</p>
      <NoteField id="offer-decline-reason" label="Reason (optional)" value={reason} onChange={setReason} disabled={frozen} />
      {error && <div style={ERROR_BANNER_STYLE} role="alert">{error}</div>}
      <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <BrandButton variant="secondary" disabled={locked} onClick={onCancel}>Cancel</BrandButton>
        <BrandButton disabled={locked} onClick={() => onSubmit(reason.trim() ? { reason: reason.trim() } : {})}>
          {busy ? 'Sending…' : 'Yes, decline'}
        </BrandButton>
      </div>
    </div>
  );
}

function SignBlock({ name, onName, onAccept, busy, saving, frozen }) {
  const valid = signedNameValid(name);
  return (
    <div style={{ marginTop: 18 }}>
      <label htmlFor="offer-sign-name" style={LABEL_STYLE}>Type your full name to sign</label>
      <input
        id="offer-sign-name"
        type="text"
        disabled={frozen}
        autoComplete="name"
        maxLength={120}
        value={name}
        onChange={(e) => onName(e.target.value)}
        style={FIELD_STYLE}
      />
      <BrandButton fullWidth disabled={!valid || busy} onClick={onAccept} style={{ marginTop: 12 }}>
        {saving ? 'Saving…' : 'Accept and sign'}
      </BrandButton>
    </div>
  );
}

function OpenOffer({ token, data, outdated, onApplied, onRefused, onReload, onRecheck, onInvalid, onOwnAnswer }) {
  const [name, setName] = useState('');
  const [panel, setPanel] = useState('none'); // none | date | decline
  const [unknown, setUnknown] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const markUnknown = useCallback(() => setUnknown(true), []);
  const accept = useOfferAction({
    token,
    onApplied: (b, sent) => {
      // A replay signed nothing: the same name was signed first (another tab,
      // or an earlier send of this one whose reply was lost). It names the
      // stored signature, and it is not this tab's own answer.
      const { replay, ...answer } = b || {};
      if (!replay) onOwnAnswer(answer.state);
      onApplied({ ...answer, signedName: answer.signedName || sent.signedName });
    },
    onRefused,
    onReload,
    onRecheck,
    onUnknown: markUnknown,
  });
  const dateReq = useOfferAction({
    token,
    onApplied: (b, sent) => {
      onOwnAnswer(b?.state);
      onApplied({ requestedStartDate: sent.requestedStartDate, ...b });
    },
    onRefused,
    onReload,
    onRecheck,
    onUnknown: markUnknown,
  });
  const decline = useOfferAction({
    token,
    onApplied: (b) => {
      onOwnAnswer(b?.state);
      onApplied(b);
    },
    onRefused,
    onReload,
    onRecheck,
    onUnknown: markUnknown,
  });
  const [consentPending, setConsentPending] = useState(false);
  // The last write may or may not have gone through and the offer could not be
  // read: every action stays locked until a read works.
  // A read the page cannot use marks it out of date instead: its reload offer
  // replaces Check again, which would only read the same answer again.
  const recheck = async () => {
    setRechecking(true);
    const after = await onReload();
    setRechecking(false);
    if (after === 'open' || after === 'outdated') setUnknown(false);
  };
  // A send in flight, or one whose reply was lost.
  const frozen = accept.frozen || dateReq.frozen || decline.frozen;
  // Locks every action and the text box: such a send, a refusal whose refresh
  // failed, or a page out of date.
  const blocked = frozen || unknown || outdated;
  const anyBusy = blocked || consentPending;
  // A send whose outcome is not known yet (the text choice's included): the
  // page offers no reload meanwhile.
  const unresolved = frozen || consentPending;

  return (
    <Column>
      <div style={EYEBROW}>Waves</div>
      <h1 style={H1_STYLE}>Your job offer</h1>
      <BrandCard padding={24}>
        <p style={BODY_STYLE}>
          Signed by {data.owner?.name || 'Adam'}, {data.owner?.title || 'owner'}
          {data.owner?.sentOn ? <>{' · '}<span style={{ whiteSpace: 'nowrap' }}>{formatSentOn(data.owner.sentOn)}</span></> : null}
        </p>
        <OfferSummary data={data} />
        <TermsSection terms={data.terms} />
        <p style={{ ...BODY_STYLE, borderTop: '1px solid var(--border, #E2E8F0)', paddingTop: 12 }}>
          Please don&rsquo;t give notice at your current job until you have signed this offer.
        </p>
        <TextConsent token={token} initial={data.textConsent} version={data.version} onPending={setConsentPending} onStale={onRecheck} onSnapshot={onApplied} onRefused={onRefused} onInvalid={onInvalid} locked={blocked} />
        <SignBlock
          name={name}
          onName={setName}
          busy={anyBusy}
          saving={accept.busy}
          frozen={accept.frozen}
          onAccept={() => {
            accept.run('/accept', { signedName: name.trim(), version: data.version });
          }}
        />
        {accept.error && <div style={ERROR_BANNER_STYLE} role="alert">{accept.error}</div>}
        <LostBanner action={accept} />
        {unknown && (
          <div style={ERROR_BANNER_STYLE} role="alert">
            {REFRESH_ERROR}
            <div style={{ marginTop: 8 }}>
              <BrandButton variant="secondary" disabled={rechecking} onClick={recheck}>
                {rechecking ? 'Checking…' : 'Check again'}
              </BrandButton>
            </div>
          </div>
        )}
        <OutdatedBanner outdated={outdated} unresolved={unresolved} />

        <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
          <BrandButton fullWidth variant="secondary" disabled={anyBusy} onClick={() => setPanel(panel === 'date' ? 'none' : 'date')}>
            Ask for another start date
          </BrandButton>
          <BrandButton fullWidth variant="ghost" disabled={anyBusy} onClick={() => setPanel(panel === 'decline' ? 'none' : 'decline')}>
            Decline
          </BrandButton>
        </div>

        {panel === 'date' && (
          <DateRequestPanel
            busy={dateReq.busy}
            frozen={dateReq.frozen}
            locked={anyBusy}
            error={dateReq.error}
            onCancel={() => setPanel('none')}
            onSubmit={(payload) => dateReq.run('/date-request', { ...payload, version: data.version })}
          />
        )}
        <LostBanner action={dateReq} />
        {panel === 'decline' && (
          <DeclinePanel
            busy={decline.busy}
            frozen={decline.frozen}
            locked={anyBusy}
            error={decline.error}
            onCancel={() => setPanel('none')}
            onSubmit={(payload) => decline.run('/decline', { ...payload, version: data.version })}
          />
        )}
        <LostBanner action={decline} />

        {data.expiresAt && (
          <p style={{ ...BODY_STYLE, marginTop: 18, fontSize: 14, color: MUTED, textAlign: 'center' }}>
            Open until {formatExpiry(data.expiresAt)}
          </p>
        )}
      </BrandCard>
    </Column>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

const CLOSED_STATES = ['expired', 'withdrawn', 'superseded'];

// A refused action on a closed offer (withdrawn, expired, replaced) answers 409
// with the closed page itself: { state, message, contactPhone }. On an answered
// offer (signed, declined, date asked) it names only the state: { state }.
const isClosedAnswer = (body) => Boolean(body) && CLOSED_STATES.includes(body.state) && typeof body.message === 'string';
const ANSWERED_STATES = ['signed', 'declined', 'date_requested'];

// Every applicant write carries the offer's version (server/services/job-offers.js
// changedSince). An open offer read, or a text-choice save, that does not carry
// one (a server from before the version) is never applied, so the page's
// version is never lost: the read marks the page out of date (readOffer), and
// the save is checked with a read. Signing stays locked until a read carries a
// version.
const hasVersion = (body) => typeof body?.version === 'string' && body.version.length > 0;
// The states the offer read answers. A read with any other state, or an open
// one without its version, its text choice, the Terms or a term of the offer
// (hasOfferFacts), is not shown (readOffer): only an explicit open state
// that carries all of them shows the signing controls, so no one signs without
// seeing the Terms, the choice and every term of the offer. The page checks
// what it shows, so an answer merged into it is checked too.
const OFFER_STATES = ['open', 'signed', 'declined', 'date_requested', 'expired', 'withdrawn', 'superseded'];
const hasTerms = (body) => typeof body.terms?.markdown === 'string' && body.terms.markdown.trim() !== '';
const signable = (body) =>
  hasVersion(body) && typeof body.textConsent === 'boolean' && hasTerms(body) && hasOfferFacts(body);
const usableOffer = (body) => OFFER_STATES.includes(body?.state) && (body.state !== 'open' || signable(body));
// The answer each action's success names. A 200 that names any other is a
// reply that cannot be read: the page reads the offer, as for a lost reply.
const ANSWER_STATE = { '/accept': 'signed', '/date-request': 'date_requested', '/decline': 'declined' };
// Throws for a reply that may have committed without saying what it did: a
// gateway error, or a 200 that does not name the action's answer.
function checkDefinite(res, suffix) {
  if (res.status >= 500) throw new Error('unknown outcome');
  if (res.ok && res.body?.state !== ANSWER_STATE[suffix]) throw new Error('unreadable answer');
}

async function readOffer(token) {
  const res = token ? await fetch(offerUrl(token)) : { status: 404 };
  if (res.status === 404) {
    const err = new Error('notfound');
    err.notFound = true;
    throw err;
  }
  if (!res.ok) throw new Error('temporary');
  const body = await res.json();
  if (!usableOffer(body)) {
    // An answer this page cannot use: from a server before the offer's version,
    // or newer than this page (a state it does not know), or missing a term the
    // page shows. Reading again gets the same answer, so it is not a failed
    // read: the first read shows the load error, and a later one marks the page
    // out of date (OfferPage `outdated`).
    const err = new Error('outdated');
    err.outdated = true;
    throw err;
  }
  return body;
}

// Keyed by token so a pending write for one link can never land on another.
// Only the link as it was sent opens the offer: 64 lowercase hex and no
// percent-encoding in the path (the browser leaves an encoded spelling encoded,
// and the router would decode it). Stored messages hide the token in every
// spelling of the link (server/utils/offer-link-redaction.js), and this page
// opens only the one spelling the server sends.
const SENT_TOKEN_RE = /^[0-9a-f]{64}$/;

export default function CareersOfferPage() {
  const { token } = useParams();
  const { pathname } = useLocation();
  const sent = SENT_TOKEN_RE.test(token || '') && !pathname.includes('%');
  return <OfferPage key={token} token={sent ? token : ''} />;
}

function OfferPage({ token }) {
  useGlassSurface(true);
  usePrivatePage();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // null | 'notfound' | 'temporary'
  // The answer this tab's own action got from the server ('signed', 'declined'
  // or 'date_requested'), or null: only that answer is told in the first person.
  const [ownAnswer, setOwnAnswer] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  // Set when this page and the server do not match: an answer met a server
  // without its route (a definite 404 while the offer still reads open), or a
  // read came back in a form the page cannot use (readOffer). Trying again
  // cannot help, so every answer stays locked and the page offers a reload,
  // which loads the page the server serves now. Only a reload clears it.
  const [outdated, setOutdated] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    readOffer(token)
      .then((body) => {
        if (cancelled || mine !== seq.current) return;
        setData(body);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || mine !== seq.current) return;
        setError(err.notFound ? 'notfound' : 'temporary');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, loadAttempt]);

  // The offer changed on the server (409) or a reply was lost: read it again.
  // Resolves 'changed' when the page now shows a state other than open,
  // 'open' when the offer is still open, 'outdated' when the read came back in
  // a form the page cannot use, and 'failed' when it could not be read.
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const body = await readOffer(token);
      if (mine !== seq.current) return 'changed';
      setData(body);
      return body.state === 'open' ? 'open' : 'changed';
    } catch (err) {
      if (mine === seq.current && err.notFound) setError('notfound');
      if (!err.outdated) return 'failed';
      setOutdated(true);
      return 'outdated';
    }
  }, [token]);

  // The read after an answer the server refused without saying where the
  // offer stands (a 409 that names no state, or a 404). A 404 wrote nothing,
  // and every server answers the read: a 404 read shows the dead link, and an
  // offer still open means the server lacks the route this page posted to.
  // Not used after a lost reply: that send may still land on a server that has
  // the route, so its resend stays the only action (useOfferAction).
  const recheck = useCallback(async (status) => {
    const after = await reload();
    if (status !== 404 || after !== 'open') return after;
    setOutdated(true);
    return 'outdated';
  }, [reload]);

  const applied = useCallback((patch) => {
    seq.current += 1;
    setData((prev) => ({ ...prev, ...patch }));
  }, []);

  const invalid = useCallback(() => setError('notfound'), []);

  // A 409 that says where the offer stands: show it now, so a failed read can
  // never hide an answer the server already gave. A closed offer comes whole.
  // An answered one names only its state, so a read fills in the details (the
  // sign time, the date asked for); if that read fails, the answer stays shown
  // without them. Returns false when the 409 does not say, so the caller reads.
  const refused = useCallback((body) => {
    if (isClosedAnswer(body)) {
      applied(body);
      return true;
    }
    if (!ANSWERED_STATES.includes(body?.state)) return false;
    applied({ state: body.state });
    reload();
    return true;
  }, [applied, reload]);

  if (loading) return <LoadingState />;
  if (error === 'notfound') return <NotValidState />;
  if (error === 'temporary' || !usableOffer(data)) {
    return <Column><PublicLoadError resource="offer link" onRetry={() => setLoadAttempt((a) => a + 1)} /></Column>;
  }
  if (CLOSED_STATES.includes(data.state)) return <ClosedState data={data} />;
  if (ANSWERED_STATES.includes(data.state)) {
    return <ResultState data={data} own={ownAnswer === data.state} />;
  }
  return <OpenOffer token={token} data={data} outdated={outdated} onApplied={applied} onRefused={refused} onReload={reload} onRecheck={recheck} onInvalid={invalid} onOwnAnswer={setOwnAnswer} />;
}
