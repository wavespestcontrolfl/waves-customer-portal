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
import { useParams } from 'react-router-dom';
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
  color: MUTED,
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
const CONNECTION_ERROR = 'Could not save that. Check your connection and try again.';

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
// so the caller re-reads the offer.
async function postJson(token, suffix, payload) {
  const res = await fetch(offerUrl(token, suffix), {
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

function resultMessage(data) {
  const who = ownerFirstName(data);
  if (data.state === 'signed') {
    const when = formatLongInstant(data.signedAt);
    return `You signed this offer${when ? ` on ${when}` : ''}. Welcome to Waves. ${who} will contact you about your first day.`;
  }
  if (data.state === 'date_requested') {
    return `Thanks. ${who} will look at your new date. If it works, he will send you an updated offer.`;
  }
  return 'You declined this offer. Thank you for your time.';
}

// signed / declined / date_requested: the answer the applicant already gave.
function ResultState({ data }) {
  return (
    <Column>
      <div style={EYEBROW}>Waves</div>
      <h1 style={H1_STYLE}>Your job offer</h1>
      <BrandCard padding={24}>
        <p style={BODY_STYLE} role="status">{resultMessage(data)}</p>
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

function TextConsent({ token, initial, onPending, onStale, onInvalid, locked }) {
  const [checked, setChecked] = useState(Boolean(initial));
  const [saving, setSaving] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [error, setError] = useState('');

  // After a write whose reply was lost, ask the server what it stored. Signing
  // stays locked until that read works.
  const confirm = async () => {
    setSaving(true);
    onPending(true);
    try {
      const body = await readOffer(token);
      setChecked(Boolean(body.textConsent));
      setUnconfirmed(false);
      setError('');
      onPending(false);
      if (body.state !== 'open') onStale();
    } catch (err) {
      if (err.notFound) onInvalid();
      else setUnconfirmed(true);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (next) => {
    setChecked(next);
    setSaving(true);
    onPending(true);
    setError('');
    let res;
    try {
      res = await postJson(token, '/text-consent', { consent: next });
    } catch {
      await confirm();
      return;
    }
    if (res.ok) setChecked(Boolean(res.body.textConsent));
    else setChecked(!next);
    if (res.status === 404) onInvalid();
    else if (res.status === 409 && (await onStale()) === 'failed') {
      // The offer changed but the new state could not be read: stay locked.
      setUnconfirmed(true);
      setSaving(false);
      return;
    } else if (!res.ok && res.status !== 409) setError(res.body?.error || CONNECTION_ERROR);
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
            <BrandButton variant="secondary" disabled={saving} onClick={confirm}>Try again</BrandButton>
          </div>
        </div>
      )}
      {error && <div style={ERROR_BANNER_STYLE} role="alert">{error}</div>}
    </div>
  );
}

function NoteField({ id, label, value, onChange }) {
  return (
    <div style={{ marginTop: 12 }}>
      <label htmlFor={id} style={LABEL_STYLE}>{label}</label>
      <textarea
        id={id}
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
function useOfferAction({ token, onApplied, onReload, onInvalid }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (suffix, payload) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await postJson(token, suffix, payload);
      if (res.status === 404) return onInvalid();
      if (res.status === 409) {
        const after = await onReload();
        if (after === 'failed') setError(REFRESH_ERROR);
        else if (after === 'open') setError(NOT_SAVED_ERROR);
        return;
      }
      if (!res.ok) {
        setError(res.body?.error || 'We could not save that. Please check what you entered and try again.');
        return;
      }
      onApplied(res.body);
    } catch {
      const after = await onReload();
      if (after !== 'changed') setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }, [busy, token, onApplied, onReload, onInvalid]);

  return { busy, error, setError, run };
}

function DateRequestPanel({ onSubmit, onCancel, busy, locked, error }) {
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
        min={tomorrowET()}
        value={date}
        onChange={(e) => { setDate(e.target.value); setTouched(true); }}
        style={FIELD_STYLE}
      />
      {touched && problem && <div style={{ ...ERROR_BANNER_STYLE, marginTop: 8 }} role="alert">{problem}</div>}
      <NoteField id="offer-date-note" label="Note (optional)" value={note} onChange={setNote} />
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

function DeclinePanel({ onSubmit, onCancel, busy, locked, error }) {
  const [reason, setReason] = useState('');
  return (
    <div role="group" aria-label="Decline this offer" style={{ marginTop: 16, padding: 14, border: '1px solid var(--border-strong, #C7D7E2)', borderRadius: 'var(--radius-md, 10px)' }}>
      <p style={BODY_STYLE}>Are you sure you want to decline this offer?</p>
      <NoteField id="offer-decline-reason" label="Reason (optional)" value={reason} onChange={setReason} />
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

function SignBlock({ name, onName, onAccept, busy }) {
  const valid = signedNameValid(name);
  return (
    <div style={{ marginTop: 18 }}>
      <label htmlFor="offer-sign-name" style={LABEL_STYLE}>Type your full name to sign</label>
      <input
        id="offer-sign-name"
        type="text"
        autoComplete="name"
        maxLength={120}
        value={name}
        onChange={(e) => onName(e.target.value)}
        style={FIELD_STYLE}
      />
      <BrandButton fullWidth disabled={!valid || busy} onClick={onAccept} style={{ marginTop: 12 }}>
        {busy ? 'Saving…' : 'Accept and sign'}
      </BrandButton>
    </div>
  );
}

function OpenOffer({ token, data, onApplied, onReload, onInvalid }) {
  const [name, setName] = useState('');
  const [panel, setPanel] = useState('none'); // none | date | decline
  const accept = useOfferAction({ token, onApplied: (b) => onApplied({ ...b, signedName: name.trim() }), onReload, onInvalid });
  const dateReq = useOfferAction({ token, onApplied, onReload, onInvalid });
  const decline = useOfferAction({ token, onApplied, onReload, onInvalid });
  const [consentPending, setConsentPending] = useState(false);
  const anyBusy = accept.busy || dateReq.busy || decline.busy || consentPending;

  return (
    <Column>
      <div style={EYEBROW}>Waves</div>
      <h1 style={H1_STYLE}>Your job offer</h1>
      <BrandCard padding={24}>
        <p style={BODY_STYLE}>
          Signed by {data.owner?.name || 'Adam'}, {data.owner?.title || 'owner'}
          {data.owner?.sentOn ? ` · ${formatSentOn(data.owner.sentOn)}` : ''}
        </p>
        <OfferSummary data={data} />
        <TermsSection terms={data.terms} />
        <p style={{ ...BODY_STYLE, borderTop: '1px solid var(--border, #E2E8F0)', paddingTop: 12 }}>
          Please don&rsquo;t give notice at your current job until you have signed this offer.
        </p>
        <TextConsent token={token} initial={data.textConsent} onPending={setConsentPending} onStale={onReload} onInvalid={onInvalid} locked={accept.busy || dateReq.busy || decline.busy} />
        <SignBlock
          name={name}
          onName={setName}
          busy={anyBusy}
          onAccept={() => accept.run('/accept', { signedName: name.trim() })}
        />
        {accept.error && <div style={ERROR_BANNER_STYLE} role="alert">{accept.error}</div>}

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
            locked={anyBusy}
            error={dateReq.error}
            onCancel={() => setPanel('none')}
            onSubmit={(payload) => dateReq.run('/date-request', payload)}
          />
        )}
        {panel === 'decline' && (
          <DeclinePanel
            busy={decline.busy}
            locked={anyBusy}
            error={decline.error}
            onCancel={() => setPanel('none')}
            onSubmit={(payload) => decline.run('/decline', payload)}
          />
        )}

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
const ANSWERED_STATES = ['signed', 'declined', 'date_requested'];

async function readOffer(token) {
  const res = await fetch(offerUrl(token));
  if (res.status === 404) {
    const err = new Error('notfound');
    err.notFound = true;
    throw err;
  }
  if (!res.ok) throw new Error('temporary');
  return res.json();
}

// Keyed by token so a pending write for one link can never land on another.
export default function CareersOfferPage() {
  const { token } = useParams();
  return <OfferPage key={token} token={token} />;
}

function OfferPage({ token }) {
  useGlassSurface(true);
  usePrivatePage();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // null | 'notfound' | 'temporary'
  const [loadAttempt, setLoadAttempt] = useState(0);
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
  // 'open' when the offer is still open, 'failed' when it could not be read.
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const body = await readOffer(token);
      if (mine !== seq.current) return 'changed';
      setData(body);
      return body.state === 'open' ? 'open' : 'changed';
    } catch (err) {
      if (mine === seq.current && err.notFound) setError('notfound');
      return 'failed';
    }
  }, [token]);

  const applied = useCallback((patch) => {
    seq.current += 1;
    setData((prev) => ({ ...prev, ...patch }));
  }, []);

  const invalid = useCallback(() => setError('notfound'), []);

  if (loading) return <LoadingState />;
  if (error === 'notfound') return <NotValidState />;
  if (error === 'temporary' || !data) {
    return <Column><PublicLoadError resource="offer link" onRetry={() => setLoadAttempt((a) => a + 1)} /></Column>;
  }
  if (CLOSED_STATES.includes(data.state)) return <ClosedState data={data} />;
  if (ANSWERED_STATES.includes(data.state)) return <ResultState data={data} />;
  return <OpenOffer token={token} data={data} onApplied={applied} onReload={reload} onInvalid={invalid} />;
}
