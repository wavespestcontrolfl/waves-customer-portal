/**
 * /h/:token — the page a new homeowner reaches from the QR code on a Waves postcard (mailer step 2c).
 *
 * The visitor is a stranger with no account. The page shows the home's street address, the quarterly pest control
 * price we worked out for it (or "Call us for your price" when there is none) and the way to act on it: call us, or,
 * when the home has a price, pick a first visit and book it on the same page (mailer step 2d-1: GET .../times, then
 * POST .../book; the answers are named in docs/public-route-contracts.md).
 * Data: GET /api/public/home/:token (server/routes/mail-home-public.js). Any failure, a dead link and the gate being
 * off all read the same: one friendly "not available" state, so the page never hints whether a token exists.
 *
 * The logo, the header phone link, the license line and the business address come from WavesShell (App.jsx wraps this
 * page like /card/:token); the page does not repeat them. The plan lines come from glassPestInclusions, the same
 * list the estimate shows for the quarterly pest plan.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { BrandButton, BrandCard, BrandInput, CustomerColumn, PublicStateCard } from '../components/brand';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_TEL } from '../constants/business';
import { glassPestInclusions } from '../lib/estimate-glass-copy';
import { arrivalWindowLabel } from '../lib/estimate-glass-slots';
import { useGlassSurface } from '../glass/glass-engine';
import { DOC, DOC_EYEBROW, FS, FW, LH, SP, docHeading } from '../theme-doc';

// Always the page's own origin: /api/public/home is mounted before every CORS handler (one answer for every miss), so a
// separate API origin (VITE_API_URL) would be refused by the browser.
const API_BASE = '/api';

// What the booking answer made lower than the page showed: { annual } and/or { setupFee } (dollars), or null.
function lowerTermsOf(bookedPrice, shownPrice) {
  if (!bookedPrice) return null;
  const annual = Number(bookedPrice.annual);
  const fee = Number(bookedPrice.setupFee);
  const lower = {};
  if (annual > 0 && annual < Number(shownPrice.annual)) lower.annual = annual;
  if (Number.isFinite(fee) && fee >= 0 && fee < (Number(shownPrice.setupFee) || 0)) lower.setupFee = fee;
  return Object.keys(lower).length ? lower : null;
}

// Cents only when the amount is not whole: $37 a month, $37.50 a month.
function formatMoney(value) {
  const n = Number(value);
  const whole = Number.isInteger(n);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// glassPestInclusions(4) = protected 4x a year, then interior included, then free callbacks. The first line
// ("Premium non-repellent...") and the last two (guarantee, contract) are left out of this short page.
const PLAN_LINES = glassPestInclusions(4).slice(1, 4);

const callButtonStyle = {
  minHeight: 48,
  width: '100%',
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 20px',
  border: 'none',
  borderRadius: 10,
  background: DOC.navyLiteral,
  color: '#FFFFFF',
  fontSize: FS.bodyLg,
  fontWeight: FW.bold,
  textDecoration: 'none',
  textTransform: 'none',
  letterSpacing: 0,
  cursor: 'pointer',
};

function Unavailable() {
  return (
    <CustomerColumn column="flow">
      <PublicStateCard state="not-found" title="This page is not available" contact="call">
        Call us and we will help.
      </PublicStateCard>
    </CustomerColumn>
  );
}

// One of the 4 applications a year, from whole cents (as the server's monthly is).
export function perApplication(annual) {
  return Math.round(Math.round(Number(annual) * 100) / 4) / 100;
}

// County records are in capitals ("101 EXAMPLE TRL"). Each word reads in normal case ("101 Example Trl"), except
// compass words (N, SW), which stay in capitals, and ordinals (1ST), which read as 1st.
const KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW']);
export function addressCase(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  return text.trim().split(/\s+/).map((word) => {
    const upper = word.toUpperCase();
    if (KEEP_UPPER.has(upper)) return upper;
    if (/^\d/.test(word)) return word.toLowerCase();
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ');
}

// ---- first visit: pick a time, book it (mailer step 2d-1) ----------------------------------------------------------------

// '2026-11-30' → a local Date (never `new Date('2026-11-30')`, which is UTC midnight and reads as the day before).
function dateOf(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d);
}
const dayChipLabel = (ymd) => dateOf(ymd).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const dayLongLabel = (ymd) => dateOf(ymd).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

// The customer's time is the arrival window: the slot start plus 2 hours (AGENTS.md), '09:00' → '9:00-11:00 AM'. The
// slot's own end_time is the visit's length and is never shown.
const slotLabel = (o) => arrivalWindowLabel(o.start_time) || o.start_label || '';

// Soonest first, always (the server sorts too; this keeps the page right if it ever does not).
const sortOffers = (offers) => [...offers].sort((a, b) => `${a.date} ${a.start_time}`.localeCompare(`${b.date} ${b.start_time}`));

const FIELD_ERRORS = {
  name: 'Enter your name.',
  phone: 'Enter a 10-digit mobile phone number.',
  email: 'Enter a valid email address.',
};

// What the visitor reads when the booking ends with the call button. Any answer not named here is the generic one.
const CALL_NOTICES = {
  price_changed: 'Your price was updated — call us.',
  contact_on_file: "You're already with Waves — call us and we'll get you scheduled.",
};
const GENERIC_NOTICE = 'Something went wrong — call us.';

const chipStyle = (selected) => ({
  flex: '0 0 auto',
  minHeight: 48,
  padding: '0 16px',
  boxSizing: 'border-box',
  border: `1px solid ${selected ? DOC.navyLiteral : DOC.borderStrong}`,
  borderRadius: 10,
  background: selected ? DOC.navyLiteral : DOC.surface,
  color: selected ? '#FFFFFF' : DOC.ink,
  fontSize: FS.body,
  fontWeight: FW.semibold,
  cursor: 'pointer',
});

const slotStyle = {
  minHeight: 48,
  padding: '0 8px',
  boxSizing: 'border-box',
  border: `1px solid ${DOC.borderStrong}`,
  borderRadius: 10,
  background: DOC.surface,
  color: DOC.ink,
  fontSize: FS.body,
  fontWeight: FW.semibold,
  cursor: 'pointer',
};

const fieldLabelStyle = { display: 'block', marginBottom: SP.xxs, fontSize: FS.body, fontWeight: FW.semibold, color: DOC.ink };
const fieldErrorStyle = { margin: `${SP.xxs}px 0 0`, fontSize: FS.body, lineHeight: LH.snug, color: DOC.danger };
const noticeStyle = { margin: `0 0 ${SP.sm}px`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.ink };

function CallButton() {
  return (
    <a href={WAVES_SUPPORT_PHONE_TEL} data-glass-accent="" data-glass-size="primary" style={callButtonStyle}>
      Call {WAVES_SUPPORT_PHONE_DISPLAY}
    </a>
  );
}

function CheckMark() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden="true" focusable="false" style={{ display: 'block', margin: '0 auto' }}>
      <circle cx="24" cy="24" r="22" fill={DOC.successBg} stroke={DOC.success} strokeWidth="2" />
      <path d="M14 25l7 7 13-15" fill="none" stroke={DOC.success} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// The lines of the booked screen that say what the booking made lower than the page showed (lowerTermsOf).
function BookedTerms({ lower }) {
  if (!lower) return null;
  return (
    <>
      {lower.annual ? (
        <p data-testid="booked-price" style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.ink }}>
          Your price is now {formatMoney(perApplication(lower.annual))} per application.
        </p>
      ) : null}
      {lower.setupFee != null ? (
        <p data-testid="booked-setup" style={{ margin: `${SP.xs}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.ink }}>
          {lower.setupFee > 0 ? `Your one-time setup is now ${formatMoney(lower.setupFee)}.` : 'No setup fee.'}
        </p>
      ) : null}
    </>
  );
}

// Shown for a home that has a price. onNeedCall(true) tells the page this card carries the call button, so the page
// does not show a second one.
function FirstVisitPicker({ token, price, address, onNeedCall, onPriceChanged }) {
  const [times, setTimes] = useState({ status: 'loading', offers: [] }); // loading | ready | call
  const [day, setDay] = useState(null);
  const [picked, setPicked] = useState(null);
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [notice, setNotice] = useState(null); // shown above the times after a refusal
  const [callNotice, setCallNotice] = useState(null); // ends the flow with the call button
  const [booked, setBooked] = useState(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const timesRun = useRef(0);

  const showOffers = useCallback((list) => {
    const offers = sortOffers(list);
    setTimes(offers.length ? { status: 'ready', offers } : { status: 'call', offers: [] });
    setDay(offers.length ? offers[0].date : null);
  }, []);

  const loadTimes = useCallback(async () => {
    const run = ++timesRun.current;
    setTimes({ status: 'loading', offers: [] });
    try {
      const r = await fetch(`${API_BASE}/public/home/${encodeURIComponent(token)}/times`);
      const json = r.ok ? await r.json() : null;
      if (run !== timesRun.current) return;
      showOffers(json && Array.isArray(json.offers) ? json.offers : []);
    } catch {
      if (run === timesRun.current) showOffers([]);
    }
  }, [token, showOffers]);

  useEffect(() => {
    loadTimes();
    return () => { timesRun.current += 1; };
  }, [loadTimes]);

  const needCall = times.status === 'call' || Boolean(callNotice);
  useEffect(() => {
    onNeedCall(needCall);
    return () => onNeedCall(false);
  }, [needCall, onNeedCall]);

  const perApp = formatMoney(perApplication(price.annual));

  const setField = (key) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
    setFieldErrors((errs) => (errs[key] ? { ...errs, [key]: null } : errs));
  };

  // The server is the authority; these only catch an empty or plainly wrong box before the request.
  const checkForm = () => {
    const errs = {};
    if (!form.name.trim()) errs.name = FIELD_ERRORS.name;
    if (form.phone.replace(/\D/g, '').length < 10) errs.phone = FIELD_ERRORS.phone;
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) errs.email = FIELD_ERRORS.email;
    return errs;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (sendingRef.current) return;
    const errs = checkForm();
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    sendingRef.current = true;
    setSending(true);
    setNotice(null);
    try {
      const r = await fetch(`${API_BASE}/public/home/${encodeURIComponent(token)}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offer: picked,
          name: form.name.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          // The price the page showed, as JSON numbers: the server refuses the booking when the price has moved.
          price: { annual: Number(price.annual), setupFee: Number(price.setupFee) || 0 },
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.booked) {
        // The price the booking was made on, kept only when it is lower than the one this page showed (the card's price
        // is held 60 days and never goes up; when ours went down the booking takes the lower one).
        setBooked({ date: body.date || picked.date, window: body.window || {}, lower: lowerTermsOf(body.price, price) });
      } else if (body.error === 'slot_taken' || body.error === 'invalid_offer') {
        setPicked(null);
        setNotice('That time was just taken. Pick another time.');
        if (body.error === 'slot_taken' && Array.isArray(body.offers) && body.offers.length) showOffers(body.offers);
        else loadTimes();
      } else if (body.error === 'invalid_contact' && FIELD_ERRORS[body.field]) {
        setFieldErrors({ [body.field]: FIELD_ERRORS[body.field] });
      } else {
        // A changed price: the card above stops showing the old one (the parent swaps it for "Call us for your price").
        if (body.error === 'price_changed' && onPriceChanged) onPriceChanged();
        setCallNotice(CALL_NOTICES[body.error] || GENERIC_NOTICE);
      }
    } catch {
      setCallNotice(GENERIC_NOTICE);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  if (booked) {
    const line1 = addressCase(address.line1);
    const city = addressCase(address.city);
    // The booking answer's window start is the committed start; the same helper makes the range the chips showed.
    const arrival = arrivalWindowLabel(booked.window.start || picked.start_time);
    return (
      <BrandCard data-testid="booked" style={{ marginTop: SP.md, textAlign: 'center' }}>
        <CheckMark />
        <h2 style={{ ...docHeading(2), marginTop: SP.sm }}>You&rsquo;re booked</h2>
        <p style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.sub, fontWeight: FW.semibold, lineHeight: LH.snug, color: DOC.ink }}>
          {dayLongLabel(booked.date)}
        </p>
        {arrival ? (
          <p style={{ margin: `${SP.xxs}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.ink }}>{arrival}</p>
        ) : null}
        {line1 || city ? (
          <p style={{ margin: `${SP.xs}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
            {line1}
            {line1 && city ? <br /> : null}
            {city}
          </p>
        ) : null}
        <BookedTerms lower={booked.lower} />
        <p style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
          Your confirmation is on its way.
        </p>
      </BrandCard>
    );
  }

  if (callNotice) {
    return (
      <BrandCard style={{ marginTop: SP.md }}>
        <p role="alert" style={noticeStyle}>{callNotice}</p>
        <CallButton />
      </BrandCard>
    );
  }

  if (times.status === 'loading') {
    return (
      <BrandCard style={{ marginTop: SP.md }}>
        <p role="status" style={{ margin: 0, fontSize: FS.bodyLg, color: DOC.supporting }}>Finding open times&hellip;</p>
      </BrandCard>
    );
  }

  if (times.status === 'call') {
    return (
      <BrandCard style={{ marginTop: SP.md }}>
        {notice ? <p role="alert" style={noticeStyle}>{notice}</p> : null}
        <h2 style={{ ...docHeading(3), marginBottom: SP.sm }}>Call us to pick a time</h2>
        <CallButton />
      </BrandCard>
    );
  }

  if (picked) {
    const fieldProps = (key) => ({
      id: `home-book-${key}`,
      value: form[key],
      onChange: setField(key),
      required: true,
      'aria-required': 'true',
      'aria-invalid': fieldErrors[key] ? 'true' : undefined,
      'aria-describedby': fieldErrors[key] ? `home-book-${key}-error` : undefined,
      error: Boolean(fieldErrors[key]),
      disabled: sending,
    });
    const fieldError = (key) => (fieldErrors[key] ? <p id={`home-book-${key}-error`} role="alert" style={fieldErrorStyle}>{fieldErrors[key]}</p> : null);
    return (
      <BrandCard style={{ marginTop: SP.md }}>
        <h2 style={{ ...docHeading(3), marginBottom: SP.xxs }}>
          {dayLongLabel(picked.date)}, {slotLabel(picked)}
        </h2>
        <p style={{ margin: 0, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
          Quarterly pest control &middot; {perApp} per application
        </p>
        <form onSubmit={submit} noValidate style={{ marginTop: SP.md, display: 'grid', gap: SP.md }}>
          <div>
            <label htmlFor="home-book-name" style={fieldLabelStyle}>Your name</label>
            <BrandInput {...fieldProps('name')} type="text" autoComplete="name" />
            {fieldError('name')}
          </div>
          <div>
            <label htmlFor="home-book-phone" style={fieldLabelStyle}>Mobile phone</label>
            <BrandInput {...fieldProps('phone')} type="tel" autoComplete="tel" inputMode="tel" />
            {fieldError('phone')}
          </div>
          <div>
            <label htmlFor="home-book-email" style={fieldLabelStyle}>Email</label>
            <BrandInput {...fieldProps('email')} type="email" autoComplete="email" />
            {fieldError('email')}
          </div>
          <BrandButton type="submit" fullWidth disabled={sending}>
            {sending ? 'Booking…' : 'Book this visit'}
          </BrandButton>
          <BrandButton variant="ghost" fullWidth disabled={sending} onClick={() => { setPicked(null); setFieldErrors({}); }}>
            Pick a different time
          </BrandButton>
        </form>
      </BrandCard>
    );
  }

  const days = [...new Set(times.offers.map((o) => o.date))];
  const dayOffers = times.offers.filter((o) => o.date === day);
  return (
    <BrandCard style={{ marginTop: SP.md }}>
      <h2 style={{ ...docHeading(3), marginBottom: SP.sm }}>Pick your first visit</h2>
      {notice ? <p role="alert" style={noticeStyle}>{notice}</p> : null}
      <div role="group" aria-label="Day" style={{ display: 'flex', gap: SP.xs, overflowX: 'auto', paddingBottom: SP.xxs }}>
        {days.map((d) => (
          <button key={d} type="button" aria-pressed={d === day} onClick={() => setDay(d)} style={chipStyle(d === day)}>
            {dayChipLabel(d)}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Time" style={{ marginTop: SP.sm, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SP.xs }}>
        {dayOffers.map((o) => (
          <button key={`${o.date}-${o.start_time}-${o.slot_sig}`} type="button" onClick={() => { setNotice(null); setPicked(o); }} style={slotStyle}>
            {slotLabel(o)}
          </button>
        ))}
      </div>
    </BrandCard>
  );
}

export default function MailHomePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | unavailable
  const [pickerHasCall, setPickerHasCall] = useState(false);
  const [priceStale, setPriceStale] = useState(false);
  useGlassSurface(true);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    setPriceStale(false); // a price_changed answer belongs to the home it was for, not the next link
    fetch(`${API_BASE}/public/home/${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        if (json && json.address) { setData(json); setStatus('ready'); } else setStatus('unavailable');
      })
      .catch(() => { if (alive) setStatus('unavailable'); });
    return () => { alive = false; };
  }, [token]);

  if (status === 'loading') {
    return (
      <CustomerColumn column="flow">
        <p role="status" style={{ margin: 0, textAlign: 'center', fontSize: FS.bodyLg, color: DOC.supporting }}>
          Loading your page&hellip;
        </p>
      </CustomerColumn>
    );
  }
  if (status === 'unavailable') return <Unavailable />;

  const line1 = addressCase(data.address.line1) || null;
  const city = addressCase(data.address.city) || null;
  const price = data.price;
  // The price card shows no price once a booking answered price_changed; the picker keeps the price it was opened with.
  const cardPrice = priceStale ? null : price;
  const setupFee = cardPrice && Number(cardPrice.setupFee) > 0 ? Number(cardPrice.setupFee) : null;

  return (
    <CustomerColumn column="flow">
      <div data-gt="eyebrow" style={DOC_EYEBROW}>Waves Pest Control</div>
      <h1 style={docHeading(1)}>Welcome to your new home</h1>
      {(line1 || city) && (
        <p data-testid="address" style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.sub, lineHeight: LH.snug, color: DOC.muted }}>
          {line1}
          {line1 && city ? <br /> : null}
          {city}
        </p>
      )}

      <BrandCard style={{ marginTop: SP.xl, textAlign: 'center' }}>
        {cardPrice ? (
          <>
            {/* AGENTS.md "Per application" price copy: the per-application price is the price; the month average sits
                beneath it, smaller. A quarterly plan is 4 applications a year. */}
            <div data-testid="application-price" style={{ fontSize: 44, fontWeight: FW.bold, lineHeight: LH.display, color: DOC.ink, letterSpacing: '-0.02em' }}>
              {formatMoney(perApplication(cardPrice.annual))}
            </div>
            <p style={{ margin: `${SP.xs}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.ink }}>
              per application, 4 a year
            </p>
            <p data-testid="monthly-price" style={{ margin: `${SP.xs}px 0 0`, fontSize: FS.body, lineHeight: LH.body, color: DOC.muted }}>
              About {formatMoney(cardPrice.monthly)} a month
            </p>
            <p style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
              Quarterly pest control{line1 ? ` for ${line1}` : ''}
            </p>
            {setupFee ? (
              <p style={{ margin: `${SP.xs}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
                One-time setup: {formatMoney(setupFee)}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div style={{ fontSize: FS.h2, fontWeight: FW.bold, lineHeight: LH.heading, color: DOC.ink }}>
              Call us for your price
            </div>
            <p style={{ margin: `${SP.sm}px 0 0`, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
              Quarterly pest control{line1 ? ` for ${line1}` : ''}
            </p>
          </>
        )}
      </BrandCard>

      {price ? <FirstVisitPicker token={token} price={price} address={data.address} onNeedCall={setPickerHasCall} onPriceChanged={() => setPriceStale(true)} /> : null}

      <BrandCard style={{ marginTop: SP.md }}>
        <h2 style={{ ...docHeading(3), marginBottom: SP.sm }}>What the plan includes</h2>
        <ul style={{ margin: 0, paddingLeft: SP.lg, fontSize: FS.bodyLg, lineHeight: LH.body, color: DOC.muted }}>
          {PLAN_LINES.map((line) => (
            <li key={line} style={{ marginTop: SP.xs }}>{line}</li>
          ))}
        </ul>
      </BrandCard>

      {pickerHasCall ? null : (
        <div style={{ marginTop: SP.xl }}>
          <CallButton />
        </div>
      )}
    </CustomerColumn>
  );
}
