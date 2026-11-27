/**
 * <CareersInterviewPage> — /careers/interview/:token
 *
 * Public, token-gated self-scheduling page. An applicant moved to the
 * "interview" stage gets this link by text + email (recruiting-comms PR 1)
 * and uses it to pick a phone or in-person interview time, or to withdraw
 * their application. The same link re-opens after booking so the applicant
 * can change the time.
 *
 * Modeled on RatePage.jsx: WavesShell wraps this page at the route (App.jsx),
 * not here. Terminal states go through PublicStateCard / PublicLoadError so
 * this page carries no hand-rolled not-found/error card of its own.
 *
 * Dates/times are never re-derived client-side — every label shown comes
 * from the API's own `label` (and `date` for grouping), already formatted
 * ET wall-clock server-side (server/utils/datetime-et.js). This page never
 * calls toISOString() to build a displayed date or time.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import {
  CustomerColumn,
  BrandCard,
  BrandButton,
  PublicStateCard,
  HelpPhoneLink,
} from '../components/brand';
import PublicLoadError from '../components/PublicLoadError';
import { useGlassSurface } from '../glass/glass-engine';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const TEXT = COLORS.glassNavy;
const MUTED = COLORS.textCaption;

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
  fontSize: 24,
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

const DAY_HEADER_STYLE = {
  fontFamily: FONTS.ui,
  fontSize: 14,
  fontWeight: 700,
  color: TEXT,
  margin: '0 0 8px',
};

function modeCardStyle(selected) {
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    minHeight: 44,
    padding: '14px 16px',
    border: `1px solid ${selected ? 'var(--brand, #04395E)' : 'var(--border-strong, #C7D7E2)'}`,
    borderRadius: 'var(--radius-md, 10px)',
    background: selected ? 'var(--brand-soft, #E3F5FD)' : 'var(--surface, #FFFFFF)',
    cursor: 'pointer',
    boxSizing: 'border-box',
  };
}

function slotButtonStyle(selected) {
  return {
    minHeight: 44,
    minWidth: 44,
    padding: '0 14px',
    border: `1px solid ${selected ? 'var(--brand, #04395E)' : 'var(--border-strong, #C7D7E2)'}`,
    borderRadius: 'var(--radius-md, 10px)',
    background: selected ? 'var(--brand, #04395E)' : 'var(--surface, #FFFFFF)',
    color: selected ? '#FFFFFF' : TEXT,
    fontFamily: FONTS.ui,
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    boxSizing: 'border-box',
  };
}

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

const LOW_EMPHASIS_LINK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  padding: '0 4px',
  border: 'none',
  background: 'transparent',
  color: MUTED,
  fontFamily: FONTS.ui,
  fontSize: 14,
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  cursor: 'pointer',
};

const SENT_TOKEN_RE = /^[0-9a-f]{64}$/;

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

const COPY = {
  en: {
    loading: 'Loading…',
    inactiveTitle: 'This interview link is no longer active',
    inactiveBody: 'It may have already been used, or your application has moved on. Give us a call and we can help — ',
    withdrawnTitle: 'Thanks for letting us know',
    withdrawnBody: 'We’ve closed out your application. If you change your mind, reach out any time — ',
    eyebrow: 'Interview scheduling',
    greeting: (name) => `Hi ${name || 'there'}`,
    bookedEyebrow: 'You’re booked',
    changeTime: 'Change time',
    intro: 'Pick whichever works best for you. You can always come back to this link to change it.',
    backToBooked: 'Back to my booked time',
    modeLegend: 'How would you like to interview?',
    phoneLabel: 'Phone call',
    inPersonPrefix: 'In person',
    pickTime: 'Pick a time',
    tzNote: 'All times Eastern (ET)',
    noSlots: 'No times are open right now. Give us a call and we’ll find a time together — ',
    timesFor: (day) => `Times for ${day}`,
    pickedSummary: (mode, label) => `You picked ${mode === 'phone' ? 'a phone call' : 'an in-person visit'} on ${label} ET.`,
    booking: 'Booking…',
    confirmTime: 'Confirm interview time',
    slotGoneFallback: 'That time is no longer available. Pick another time below.',
    unconfirmed: 'We could not confirm that time. Check your connection and try again.',
    notInterested: 'I’m no longer interested',
    withdrawPrompt: 'Are you sure? This will withdraw your application.',
    withdrawError: 'Could not process that. Check your connection and try again.',
    cancel: 'Cancel',
    submitting: 'Submitting…',
    yesWithdraw: 'Yes, withdraw',
    modeLine: (mode, addr) => (mode === 'in_person' ? `See you at ${addr}` : "We'll call you at this number"),
    onWord: 'on',
  },
  es: {
    loading: 'Cargando…',
    inactiveTitle: 'Este enlace de entrevista ya no está activo',
    inactiveBody: 'Es posible que ya se haya usado o que tu solicitud haya avanzado. Llámanos y con gusto te ayudamos — ',
    withdrawnTitle: 'Gracias por avisarnos',
    withdrawnBody: 'Hemos cerrado tu solicitud. Si cambias de opinión, contáctanos cuando quieras — ',
    eyebrow: 'Programación de entrevista',
    greeting: (name) => `Hola ${name || ''}`.trim(),
    bookedEyebrow: 'Tu entrevista está confirmada',
    changeTime: 'Cambiar horario',
    intro: 'Elige la opción que mejor te funcione. Siempre puedes volver a este enlace para cambiarla.',
    backToBooked: 'Volver a mi horario reservado',
    modeLegend: '¿Cómo prefieres realizar la entrevista?',
    phoneLabel: 'Llamada telefónica',
    inPersonPrefix: 'En persona',
    pickTime: 'Elige un horario',
    tzNote: 'Todas las horas en hora del Este (ET)',
    noSlots: 'No hay horarios disponibles en este momento. Llámanos y buscaremos un horario juntos — ',
    timesFor: (day) => `Horarios para ${day}`,
    pickedSummary: (mode, label) => `Elegiste ${mode === 'phone' ? 'una llamada telefónica' : 'una entrevista en persona'} el ${label} ET.`,
    booking: 'Reservando…',
    confirmTime: 'Confirmar horario de entrevista',
    slotGoneFallback: 'Ese horario ya no está disponible. Elige otro horario abajo.',
    unconfirmed: 'No pudimos confirmar ese horario. Revisa tu conexión e inténtalo de nuevo.',
    notInterested: 'Ya no estoy interesado/a',
    withdrawPrompt: '¿Estás seguro/a? Esto retirará tu solicitud.',
    withdrawError: 'No pudimos procesar tu solicitud. Revisa tu conexión e inténtalo de nuevo.',
    cancel: 'Cancelar',
    submitting: 'Enviando…',
    yesWithdraw: 'Sí, retirar solicitud',
    modeLine: (mode, addr) => (mode === 'in_person' ? `Nos vemos en ${addr}` : 'Te llamaremos a este número'),
    onWord: 'el',
  },
};

function copyFor(lang) {
  return lang === 'es' ? COPY.es : COPY.en;
}

// slot.label from the API looks like "Tue Sep 22, 4:30 PM" — split it once
// for the day-group header and the per-slot button text. Never recomputed
// from slot.start with Date/toISOString.
function splitSlotLabel(label) {
  const parts = String(label || '').split(', ');
  return { dayLabel: parts[0] || label || '', timeLabel: parts[1] || label || '' };
}

function groupSlotsByDay(slots) {
  const order = [];
  const byDate = new Map();
  for (const slot of slots || []) {
    const key = slot.date || slot.start;
    if (!byDate.has(key)) {
      byDate.set(key, []);
      order.push(key);
    }
    byDate.get(key).push(slot);
  }
  return order.map((key) => {
    const daySlots = byDate.get(key);
    const { dayLabel } = splitSlotLabel(daySlots[0]?.label);
    return {
      date: key,
      dayLabel,
      slots: daySlots.map((slot) => ({ ...slot, timeLabel: splitSlotLabel(slot.label).timeLabel })),
    };
  });
}

// Full-page "still loading" card. Stateless — no reason for the applicant
// data or callbacks to reach this far.
function InterviewLoadingState() {
  return (
    <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
      <BrandCard padding={28}>
        <div style={{ padding: '40px 20px', textAlign: 'center', color: MUTED, fontSize: 16 }}>
          Loading…
        </div>
      </BrandCard>
    </CustomerColumn>
  );
}

// Full-page terminal states: a dead link, a load that failed and can be
// retried, or a completed withdrawal. Each ends the applicant's session on
// this page, so they share one component rather than three near-duplicate
// early returns in the page body.
function InterviewTerminalState({ kind, lang, onRetry }) {
  const t = copyFor(lang);
  if (kind === 'notfound') {
    return (
      <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
        <PublicStateCard state="not-found" title={t.inactiveTitle} contact="none">
          {t.inactiveBody}<HelpPhoneLink tone="dark" inline />.
        </PublicStateCard>
      </CustomerColumn>
    );
  }
  if (kind === 'withdrawn') {
    return (
      <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
        <PublicStateCard state="withdrawn" title={t.withdrawnTitle} contact="none">
          {t.withdrawnBody}<HelpPhoneLink tone="dark" inline />.
        </PublicStateCard>
      </CustomerColumn>
    );
  }
  return (
    <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
      <PublicLoadError resource="interview link" onRetry={onRetry} />
    </CustomerColumn>
  );
}

// Booking flow: pick a mode + time and confirm, or review/change an existing
// booking. Owns its own in-progress state (changingTime/mode/selectedSlot/
// booking/bookError) — none of it is needed outside this panel, so it lives
// here instead of being threaded down from the page.
function InterviewBookingPanel({ token, data, onDataChange, onInactiveLink }) {
  const t = copyFor(data?.language);
  const [changingTime, setChangingTime] = useState(false);
  const [mode, setMode] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState('');

  const groups = useMemo(() => groupSlotsByDay(data?.slots), [data?.slots]);

  // Every booking attempt and every refresh bumps this; a refresh response
  // only lands when nothing newer started after it, so a slow re-fetch from
  // a slot conflict can never overwrite a booking that committed in the
  // meantime with stale "open" data (Codex r17 P2).
  const attemptSeq = useRef(0);

  // Quiet re-fetch after a slot turns out to be taken — refreshes the slot
  // list without dropping the applicant into the full-page loading state.
  const refreshSlots = useCallback(async () => {
    const seq = ++attemptSeq.current;
    try {
      const res = await fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}`);
      if (!res.ok || seq !== attemptSeq.current) return;
      const body = await res.json();
      if (seq !== attemptSeq.current) return;
      onDataChange(body);
    } catch {
      // best-effort; the inline error already told them to pick again
    }
  }, [token, onDataChange]);

  const startChangeTime = () => {
    setChangingTime(true);
    setMode(data?.booked?.mode || null);
    setSelectedSlot(null);
    setBookError('');
  };

  const confirmBooking = async () => {
    if (!mode || !selectedSlot || booking) return;
    attemptSeq.current += 1; // any in-flight slot refresh is now stale
    setBooking(true);
    setBookError('');
    try {
      const res = await fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, start: selectedSlot.start }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 || res.status === 404) {
        onInactiveLink();
        return;
      }
      if (!res.ok) {
        setSelectedSlot(null);
        setBookError(body.error || t.slotGoneFallback);
        refreshSlots();
        return;
      }
      onDataChange(body);
      setChangingTime(false);
      setSelectedSlot(null);
    } catch {
      const seq = ++attemptSeq.current;
      try {
        const res = await fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}`);
        if (seq !== attemptSeq.current) return;
        if (res.status === 404) {
          onInactiveLink();
          return;
        }
        const body = res.ok ? await res.json() : null;
        if (seq !== attemptSeq.current) return;
        if (body?.booked && body.booked.mode === mode && body.booked.start === selectedSlot.start) {
          onDataChange(body);
          setChangingTime(false);
          setSelectedSlot(null);
          return;
        }
      } catch {
        // still offline — fall through to the unconfirmed message
      }
      setBookError(t.unconfirmed);
    } finally {
      setBooking(false);
    }
  };

  const showBooked = Boolean(data.booked) && !changingTime;

  if (showBooked) {
    return (
      <BrandCard padding={24}>
        <div style={EYEBROW}>{t.bookedEyebrow}</div>
        <p style={BODY_STYLE}>
          {t.modeLine(data.booked.mode, data.in_person_address)} {t.onWord}{' '}
          <strong>{data.booked.label} ET</strong>.
        </p>

        <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
          <BrandButton variant="secondary" onClick={startChangeTime}>
            {t.changeTime}
          </BrandButton>
        </div>
      </BrandCard>
    );
  }

  return (
    <BrandCard padding={24}>
      <p style={BODY_STYLE}>{t.intro}</p>

      {changingTime && data.booked && (
        <button
          type="button"
          style={{ ...LOW_EMPHASIS_LINK_STYLE, marginTop: 6, padding: '0' }}
          onClick={() => {
            setChangingTime(false);
            setBookError('');
          }}
        >
          {t.backToBooked}
        </button>
      )}

      <fieldset style={{ border: 'none', padding: 0, margin: '18px 0 0' }}>
        <legend style={EYEBROW}>{t.modeLegend}</legend>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          {(data.mode_options || []).map((opt) => (
            <label key={opt} style={modeCardStyle(mode === opt)}>
              <input
                type="radio"
                name="interview-mode"
                value={opt}
                checked={mode === opt}
                onChange={() => {
                  setMode(opt);
                  setBookError('');
                }}
                style={{ marginTop: 3, width: 16, height: 16, accentColor: 'var(--brand, #04395E)' }}
              />
              <span style={{ fontFamily: FONTS.ui, fontSize: 14, color: TEXT, lineHeight: 1.4 }}>
                {opt === 'in_person'
                  ? `${t.inPersonPrefix} — ${data.in_person_address}`
                  : opt === 'phone'
                    ? t.phoneLabel
                    : opt}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div style={{ marginTop: 20 }}>
        <div style={EYEBROW}>{t.pickTime}</div>
        <p style={{ ...BODY_STYLE, fontSize: 14, color: MUTED, marginBottom: 10 }}>{t.tzNote}</p>
        {groups.length === 0 ? (
          <p style={BODY_STYLE}>
            {t.noSlots}<HelpPhoneLink tone="dark" inline />.
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.date} style={{ marginBottom: 16 }}>
              <div style={DAY_HEADER_STYLE}>{group.dayLabel}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }} role="group" aria-label={t.timesFor(group.dayLabel)}>
                {group.slots.map((slot) => (
                  <button
                    key={slot.start}
                    type="button"
                    aria-pressed={selectedSlot?.start === slot.start}
                    style={slotButtonStyle(selectedSlot?.start === slot.start)}
                    onClick={() => {
                      setSelectedSlot(slot);
                      setBookError('');
                    }}
                  >
                    {slot.timeLabel}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {selectedSlot && mode && (
        <div
          style={{
            marginTop: 4,
            padding: '10px 12px',
            background: 'var(--brand-soft, #E3F5FD)',
            border: '1px solid var(--border-strong, #C7D7E2)',
            borderRadius: 'var(--radius-md, 10px)',
            fontSize: 14,
            color: TEXT,
          }}
        >
          {t.pickedSummary(mode, selectedSlot.label)}
        </div>
      )}

      {bookError && <div style={ERROR_BANNER_STYLE} role="alert">{bookError}</div>}

      <BrandButton
        fullWidth
        disabled={!mode || !selectedSlot || booking}
        onClick={confirmBooking}
        style={{ marginTop: 16 }}
      >
        {booking ? t.booking : t.confirmTime}
      </BrandButton>
    </BrandCard>
  );
}

// Withdrawal control: a low-emphasis link that expands into a confirm step.
// Owns its own confirming/submitting state and the withdraw POST — the page
// only needs to know when it succeeds (to show the terminal state) or hits
// an inactive link (409/404, same as the booking panel's handling).
function WithdrawalControl({ token, lang, onWithdrawn, onInactiveLink }) {
  const t = copyFor(lang);
  const [withdrawStep, setWithdrawStep] = useState('idle'); // idle | confirming | submitting
  const [withdrawError, setWithdrawError] = useState('');

  const confirmWithdraw = async () => {
    setWithdrawStep('submitting');
    setWithdrawError('');
    try {
      const res = await fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}/withdraw`, {
        method: 'POST',
      });
      if (res.status === 404) {
        onInactiveLink();
        return;
      }
      if (!res.ok) throw new Error('failed');
      onWithdrawn();
    } catch {
      setWithdrawError(t.withdrawError);
      setWithdrawStep('confirming');
    }
  };

  return (
    <div style={{ marginTop: 20, paddingTop: 4 }}>
      {withdrawStep === 'idle' ? (
        <button type="button" style={LOW_EMPHASIS_LINK_STYLE} onClick={() => setWithdrawStep('confirming')}>
          {t.notInterested}
        </button>
      ) : (
        <div role="alert">
          <p style={BODY_STYLE}>{t.withdrawPrompt}</p>
          {withdrawError && <div style={ERROR_BANNER_STYLE}>{withdrawError}</div>}
          <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <BrandButton
              variant="secondary"
              disabled={withdrawStep === 'submitting'}
              onClick={() => setWithdrawStep('idle')}
            >
              {t.cancel}
            </BrandButton>
            <BrandButton disabled={withdrawStep === 'submitting'} onClick={confirmWithdraw}>
              {withdrawStep === 'submitting' ? t.submitting : t.yesWithdraw}
            </BrandButton>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CareersInterviewPage() {
  const { token } = useParams();
  const { pathname } = useLocation();
  const sent = SENT_TOKEN_RE.test(token || '') && !pathname.includes('%');
  return <InterviewPage key={token} token={sent ? token : ''} />;
}

function InterviewPage({ token }) {
  useGlassSurface(true);
  usePrivatePage();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState(token ? null : 'notfound'); // null | 'notfound' | 'temporary'
  const [loadAttempt, setLoadAttempt] = useState(0);

  const [withdrawn, setWithdrawn] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      setError('notfound');
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/public/careers/interview/${encodeURIComponent(token)}`)
      .then((res) => {
        if (res.status === 404) {
          const err = new Error('notfound');
          err.notFound = true;
          throw err;
        }
        if (!res.ok) throw new Error('temporary');
        return res.json();
      })
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.notFound ? 'notfound' : 'temporary');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, loadAttempt]);

  if (loading) {
    return <InterviewLoadingState />;
  }

  // A completed withdrawal is the applicant's own final action and outranks
  // every other terminal state (Codex r21 P3): a booking request still
  // settling when they withdrew comes back 404 and must not replace the
  // confirmation with "link no longer active".
  if (withdrawn) {
    return <InterviewTerminalState kind="withdrawn" lang={data?.language} />;
  }

  if (error === 'notfound') {
    return <InterviewTerminalState kind="notfound" lang={data?.language} />;
  }

  if (error === 'temporary' || !data) {
    return <InterviewTerminalState kind="temporary" lang={data?.language} onRetry={() => setLoadAttempt((a) => a + 1)} />;
  }

  const t = copyFor(data.language);
  const goInactive = () => {
    setData(null);
    setError('notfound');
  };

  return (
    <CustomerColumn style={{ position: 'relative', zIndex: 1 }}>
      <div style={EYEBROW}>{t.eyebrow}</div>
      <h1 style={{ ...H1_STYLE, fontSize: 26 }}>{t.greeting(data.first_name)}</h1>

      <InterviewBookingPanel
        key={token}
        token={token}
        data={data}
        onDataChange={setData}
        onInactiveLink={goInactive}
      />

      {/* Withdrawing is offered in BOTH booking states: an applicant who was
          invited but is not interested should be able to say so without
          first booking a time (local audit P1). */}
      <WithdrawalControl
        key={`withdraw-${token}`}
        token={token}
        lang={data.language}
        onWithdrawn={() => setWithdrawn(true)}
        onInactiveLink={goInactive}
      />
    </CustomerColumn>
  );
}
