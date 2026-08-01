/**
 * Public appointment page — /appointment/:token.
 *
 * The destination the 24-hour reminder and the booking-confirmation texts
 * link to (owner direction 2026-07-30: short text, detail on the page).
 * Token-gated, no login: fetch GET /api/public/appointment/:token, render
 * by state. Layout and copy are the owner-approved mock from that session:
 * status pill -> service-naming heading -> appointment row with the
 * 2-hour window -> plain-language window line -> storm heads-up (stormy
 * days only) -> tech block -> plan note -> Confirm (new bookings) -> Add
 * to calendar, then "Need a different time?" and "Questions?".
 *
 * Styling follows TrackPage / ReschedulePage: WavesShell customer variant,
 * the glass scene, and the same warm-surface inline palette. The owner
 * explicitly removed the app-download block from this family of pages —
 * do not re-add it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { COLORS, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { WavesShell } from '../components/brand';
import BrandFooter from '../components/BrandFooter';
import Icon from '../components/Icon';
import { useGlassSurface } from '../glass/glass-engine';
import {
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
} from '../constants/business';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const FONT_BODY = "'Inter', system-ui, sans-serif";
const S = {
  surface: '#FFFFFF',
  page: '#FAF8F3',
  border: '#E7E2D7',
  soft: '#F8FCFE',
  softBorder: '#CFE7F5',
  text: '#04395E',
  body: '#3F4A65',
  muted: CUSTOMER_SURFACE.muted,
};

// One weather colour across the customer surfaces (owner ruling
// 2026-07-30) — the icon, not the colour, carries wet vs dry.
const WEATHER_BLUE = '#0369A1';

const PRIMARY_CTA = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  minHeight: 48,
  padding: '0 20px',
  background: COLORS.glassNavy,
  color: COLORS.white,
  border: `1px solid ${COLORS.glassNavy}`,
  borderRadius: 8,
  fontFamily: FONTS.ui,
  fontWeight: 800,
  fontSize: 15,
  cursor: 'pointer',
  textDecoration: 'none',
};

function Page({ children }) {
  return (
    <WavesShell variant="customer" topBar="solid">
      <div data-glass-clear="" style={{ flex: 1, padding: '24px 16px 40px', maxWidth: 640, width: '100%', margin: '0 auto', fontFamily: FONT_BODY, color: S.text }}>
        {children}
        <BrandFooter />
      </div>
    </WavesShell>
  );
}

function Card({ children, style, ...rest }) {
  return (
    <div data-glass="card" {...rest} style={{ background: S.surface, border: `1px solid ${S.border}`, borderRadius: 8, padding: 24, marginBottom: 16, ...style }}>
      {children}
    </div>
  );
}

function ContactRow() {
  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
      <a href={WAVES_SUPPORT_SMS_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Text Waves</a>
      <a href={WAVES_SUPPORT_PHONE_TEL} data-glass-accent="" style={{ ...PRIMARY_CTA, flex: 1 }}>Call Waves</a>
    </div>
  );
}

// date is 'YYYY-MM-DD'; render the ET calendar day as written so the
// customer sees exactly the day scheduled, regardless of device timezone.
function formatDateLabel(dateStr) {
  if (!dateStr) return '';
  try {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
  } catch {
    return dateStr;
  }
}

function formatTimeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

// The quoted arrival window is ALWAYS start + 2 hours (owner rule) — the
// server never sends window_end to a customer surface.
const ARRIVAL_WINDOW_MINUTES = 120;

function arrivalWindowLabel(start) {
  const [h, m] = String(start || '').split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const total = (h * 60 + (m || 0) + ARRIVAL_WINDOW_MINUTES) % (24 * 60);
  const end = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  return `${formatTimeLabel(start)}–${formatTimeLabel(end)}`;
}

function SkeletonCard() {
  return (
    <Card>
      <div style={{ height: 18, width: '55%', background: S.page, borderRadius: 6, marginBottom: 12 }} />
      <div style={{ height: 14, width: '80%', background: S.page, borderRadius: 6, marginBottom: 8 }} />
      <div style={{ height: 14, width: '65%', background: S.page, borderRadius: 6 }} />
    </Card>
  );
}

function MessageCard({ title, body }) {
  return (
    <Card>
      <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>{body}</div>
      <ContactRow />
    </Card>
  );
}

const STATE_COPY = {
  completed: { title: 'This visit is complete', body: 'Thanks for having us out. Questions about the service? Text or call and our team will help.' },
  cancelled: { title: 'This appointment was cancelled', body: "Want to get back on the calendar? Text or call and we'll find you a time." },
  in_progress: { title: 'Your technician is on the way', body: "This visit is already underway, so it can't be changed online. Need us? Text or call." },
  past: { title: "This visit's time has passed", body: "If we missed each other, text or call and we'll get you rescheduled right away." },
  not_available: { title: "We can't show this appointment", body: 'This link may be out of date. Text or call and our team will help.' },
};

function StatusPill({ label }) {
  return (
    <div data-glass="chip" data-glass-pill="" style={{
      display: 'inline-block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
      color: WEATHER_BLUE, background: `${WEATHER_BLUE}1A`, padding: '6px 12px', borderRadius: 9999,
    }}>
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
        background: WEATHER_BLUE, marginRight: 8, verticalAlign: 'middle',
      }} />
      {label}
    </div>
  );
}

function WeatherChip({ weather }) {
  if (!weather || weather.rainChance == null) return null;
  return (
    <span data-glass="chip" data-glass-pill="" style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0, whiteSpace: 'nowrap',
      fontSize: 12, fontWeight: 700, color: WEATHER_BLUE, background: `${WEATHER_BLUE}1A`,
      padding: '4px 10px', borderRadius: 9999,
    }}>
      <Icon name={weather.stormy ? 'cloudRain' : 'sun'} size={12} style={{ verticalAlign: '-2px' }} />
      {' '}{weather.rainChance}% rain
    </span>
  );
}

function TechBlock({ tech }) {
  if (!tech) return null;
  const name = tech.firstName || 'Your technician';
  return (
    <div data-glass="soft" style={{
      display: 'flex', alignItems: 'center', gap: 12, marginTop: 8,
      background: S.soft, border: `1px solid ${S.softBorder}`, borderRadius: 8, padding: 14,
    }}>
      {tech.photoUrl ? (
        <img
          src={tech.photoUrl}
          alt=""
          referrerPolicy="no-referrer"
          style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: `2px solid ${S.border}` }}
        />
      ) : (
        <div style={{
          width: 56, height: 56, borderRadius: '50%', flexShrink: 0,
          background: COLORS.glassNavy, color: COLORS.white,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, fontWeight: 600,
        }}>
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <div>
        <div style={{ fontSize: 17, fontWeight: 600, color: S.text, lineHeight: 1.3 }}>
          {tech.firstName ? `${tech.firstName} is your technician` : 'Your Waves technician'}
        </div>
        {tech.sameAsLastVisit ? (
          <div style={{ fontSize: 14, color: S.body, marginTop: 2 }}>The same technician as your last visit.</div>
        ) : null}
        <div style={{ fontSize: 14, color: S.body, marginTop: 2 }}>
          On service day we'll text you a live tracking link — watch them arrive in real time.
        </div>
      </div>
    </div>
  );
}

function PlanNote({ plan }) {
  if (!plan) return null;
  return (
    <div data-glass="soft" style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 8,
      background: S.soft, border: `1px solid ${S.softBorder}`, borderRadius: 8, padding: 14,
      fontSize: 14, color: S.body, lineHeight: 1.5,
    }}>
      <Icon name="refresh" size={16} style={{ flexShrink: 0, color: WEATHER_BLUE, marginTop: 1 }} />
      <span>
        {plan.isRecurring ? (
          <>
            <strong style={{ color: S.text, fontWeight: 600 }}>Part of your regular plan.</strong>{' '}
            {plan.collectiveAnchor
              ? 'If this visit moves to a different day, your later visits re-anchor around the new date — your schedule always follows your last treatment.'
              : 'Only this visit is affected if it moves — the rest of your schedule stays the same.'}
          </>
        ) : (
          <>
            <strong style={{ color: S.text, fontWeight: 600 }}>One-time treatment.</strong>{' '}
            Covered by the Waves Guarantee — if activity comes back, so do we.
          </>
        )}
      </span>
    </div>
  );
}

export default function AppointmentPage() {
  const { token } = useParams();
  useGlassSurface(true, 'full');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState(null);

  // A late response must not setState against an unmounted page or land
  // under a different token.
  const loadAbortRef = useRef(null);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setNotFound(false);
    setLoadError(false);
    try {
      const res = await fetch(`${API_BASE}/public/appointment/${token}`, { signal: controller.signal });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      if (!res.ok) throw new Error('load failed');
      const body = await res.json();
      if (controller.signal.aborted) return;
      setData(body);
    } catch {
      if (controller.signal.aborted) return;
      setLoadError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  const confirm = async () => {
    if (confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch(`${API_BASE}/public/appointment/${token}/confirm`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.success) {
        setData((prev) => (prev ? { ...prev, confirmed: true } : prev));
        return;
      }
      // The visit changed under us (cancelled, moved, started) — reload so
      // the page tells the truth instead of retrying a stale action.
      if (body.code === 'CHANGED' || body.code === 'NOT_CONFIRMABLE') {
        await load();
        setConfirmError('This appointment just changed — here are the latest details.');
        return;
      }
      setConfirmError("We couldn't confirm that just now. Please try again, or text us and we'll help.");
    } catch {
      setConfirmError("We couldn't confirm that just now. Please try again, or text us and we'll help.");
    } finally {
      setConfirming(false);
    }
  };

  if (loading) return <Page><SkeletonCard /></Page>;
  if (notFound) {
    return (
      <Page>
        <MessageCard
          title="We couldn't find that appointment"
          body="This link may have expired. Text or call us and we'll get you sorted."
        />
      </Page>
    );
  }
  if (loadError) {
    return (
      <Page>
        <Card>
          <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
            We couldn't load that appointment
          </div>
          <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
            This looks temporary. Your link is still valid—try again in a moment.
          </div>
          <button
            type="button"
            onClick={load}
            style={{ marginTop: 16, border: 0, borderRadius: 8, padding: '11px 16px', background: COLORS.glassNavy, color: '#fff', font: 'inherit', fontWeight: 800, cursor: 'pointer' }}
          >
            Try again
          </button>
        </Card>
      </Page>
    );
  }

  if (data?.state !== 'upcoming') {
    const copy = STATE_COPY[data?.state] || STATE_COPY.not_available;
    return <Page><MessageCard title={copy.title} body={copy.body} /></Page>;
  }

  const appt = data.appointment || {};
  const serviceLabel = (data.service?.type || 'service').toLowerCase();
  // Server-computed in Eastern time — the visit date is an ET calendar day,
  // and the device clock can already disagree with it.
  const isTomorrow = !!data.isTomorrow;

  return (
    <Page>
      <Card style={{ borderTop: `3px solid ${WEATHER_BLUE}` }}>
        <StatusPill label={data.confirmed ? 'Confirmed' : (isTomorrow ? 'Tomorrow' : 'Upcoming')} />
        <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginTop: 14, lineHeight: 1.3 }}>
          {data.customerFirstName ? `Hi ${data.customerFirstName} — ` : ''}your {serviceLabel} is {isTomorrow ? 'tomorrow' : 'booked'}.
        </div>

        <div data-glass="soft" style={{
          display: 'flex', alignItems: 'center', gap: 12, marginTop: 16,
          background: S.soft, border: `1px solid ${S.softBorder}`, borderRadius: 8, padding: 14,
        }}>
          <span style={{ flex: 1, fontSize: 16, fontWeight: 600, color: S.text, lineHeight: 1.3 }}>
            {formatDateLabel(appt.date)}
            {appt.windowStart ? (
              <small style={{ display: 'block', fontSize: 14, fontWeight: 500, color: S.body }}>
                2-hour arrival window · {arrivalWindowLabel(appt.windowStart)}
              </small>
            ) : null}
          </span>
          <WeatherChip weather={data.weather} />
        </div>

        <div style={{ fontSize: 15, color: S.body, lineHeight: 1.5, marginTop: 12 }}>
          Your technician arrives any time inside this 2-hour window — no waiting on a whole morning.
        </div>

        {data.weather?.stormy ? (
          <div data-glass="soft" style={{
            display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12,
            background: S.soft, border: `1px solid ${S.softBorder}`, borderRadius: 8, padding: 14,
            fontSize: 14, color: S.body, lineHeight: 1.5,
          }}>
            <Icon name="cloudRain" size={16} style={{ flexShrink: 0, color: WEATHER_BLUE, marginTop: 1 }} />
            <span>
              <strong style={{ color: S.text, fontWeight: 600 }}>Storms are possible that day.</strong>{' '}
              If we need to re-time your visit around heavy rain, you'll get a text with your new
              time — treatments need a few dry hours to bond and work as designed.
            </span>
          </div>
        ) : null}

        <TechBlock tech={data.tech} />
        <PlanNote plan={data.plan} />

        {data.confirmed ? null : (
          <>
            <button
              type="button"
              data-glass-accent=""
              onClick={confirm}
              disabled={confirming}
              style={{ ...PRIMARY_CTA, marginTop: 16, opacity: confirming ? 0.5 : 1, cursor: confirming ? 'default' : 'pointer' }}
            >
              {confirming ? 'Confirming…' : 'Confirm this appointment'}
            </button>
            <div style={{ fontSize: 14, color: S.muted, marginTop: 10, textAlign: 'center', lineHeight: 1.5 }}>
              Time doesn't work? Pick a different one below — no call needed.
            </div>
          </>
        )}
        {confirmError ? (
          <div style={{
            background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
            padding: '10px 12px', fontSize: 14, color: '#9A3412', marginTop: 12, lineHeight: 1.45,
          }}>
            {confirmError}
          </div>
        ) : null}

        <a
          data-glass="soft"
          href={`${API_BASE}/public/appointment/${token}/calendar.ics`}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            marginTop: 12, padding: '12px 16px', borderRadius: 8,
            background: S.soft, border: `1px solid ${S.softBorder}`,
            fontSize: 15, fontWeight: 600, color: S.text, textDecoration: 'none',
          }}
        >
          <Icon name="calendar" size={16} />
          Add to calendar
        </a>
      </Card>

      {data.rescheduleToken ? (
        <Card>
          <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
            Need a different time?
          </div>
          <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
            Open times near your route, one tap to move — no call needed.
          </div>
          <a href={`/reschedule/${data.rescheduleToken}`} data-glass-accent="" style={{ ...PRIMARY_CTA, marginTop: 16 }}>
            See open times
          </a>
        </Card>
      ) : null}

      <Card>
        <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, marginBottom: 8 }}>
          Questions?
        </div>
        <div style={{ fontSize: 15, color: S.body, lineHeight: 1.55 }}>
          Text or call {WAVES_SUPPORT_PHONE_DISPLAY} and our team will help.
        </div>
        <ContactRow />
      </Card>
    </Page>
  );
}
