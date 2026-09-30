import { useEffect, useState } from 'react';
import { Button } from '../Button';
import { COLORS } from '../../theme-brand';
import { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_SMS_TEL } from '../../constants/business';

// "Can't find a time that works?" block under the /book time picker
// (GATE_BOOK_PREFERRED_TIME, dark; the page renders this only when
// GET /booking/config says preferred_time). Two ways to reach the office:
// a tappable text link to the business line, and a preferred day/time form
// that POSTs /booking/preferred-time. Nothing here messages the customer —
// the server files an internal lead the office answers by hand.

const TIME_OF_DAY = [
  { id: 'morning', label: 'Morning' },
  { id: 'midday', label: 'Midday' },
  { id: 'afternoon', label: 'Afternoon' },
  { id: 'any', label: 'Any' },
];

const pad2 = (n) => String(n).padStart(2, '0');
const toYmd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export default function CantFindTimeBlock({
  zeroTimes = false,
  contact = {},
  address = {},
  serviceId = '',
  serviceLabel = '',
  getCaptureToken = () => null,
  sessionId = '',
  apiBase = '/api',
  onSubmitted,
}) {
  const [open, setOpen] = useState(!!zeroTimes);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [preferredDate, setPreferredDate] = useState('');
  const [secondDate, setSecondDate] = useState('');
  const [timeOfDay, setTimeOfDay] = useState('any');
  const [note, setNote] = useState('');
  const [website, setWebsite] = useState(''); // honeypot — real visitors never see or fill it
  const [status, setStatus] = useState('idle'); // idle | sending | done
  const [error, setError] = useState('');

  // Zero offered times → the form opens by itself.
  useEffect(() => { if (zeroTimes) setOpen(true); }, [zeroTimes]);

  // Prefill from what the booking flow already has, without overwriting what
  // the visitor has typed here.
  useEffect(() => {
    setName((prev) => prev || `${contact.firstName || ''} ${contact.lastName || ''}`.trim());
    setPhone((prev) => prev || contact.phone || '');
  }, [contact.firstName, contact.lastName, contact.phone]);

  const today = new Date();
  const min = toYmd(today);
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + 90);
  const max = toYmd(maxDate);

  const phoneDigits = phone.replace(/\D/g, '');
  const phoneOk = phoneDigits.length === 10 || (phoneDigits.length === 11 && phoneDigits.startsWith('1'));

  const submit = async (event) => {
    event.preventDefault();
    if (status === 'sending') return;
    setError('');
    if (!name.trim()) { setError('Please tell us your name.'); return; }
    if (!phoneOk) { setError('Please enter a 10-digit phone number so we can text you.'); return; }
    if (!preferredDate) { setError('Please pick the day you would like.'); return; }
    setStatus('sending');
    try {
      const res = await fetch(`${apiBase}/booking/preferred-time`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capture_token: getCaptureToken() || undefined,
          session_id: sessionId || undefined,
          name: name.trim(),
          phone,
          email: contact.email || undefined,
          preferred_date: preferredDate,
          second_date: secondDate || undefined,
          time_of_day: timeOfDay,
          note: note.trim() || undefined,
          service_id: serviceId || undefined,
          service_type: serviceLabel || undefined,
          address_line1: address.line1 || undefined,
          city: address.city || undefined,
          state: address.state || undefined,
          zip: address.zip || undefined,
          website,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('idle');
        setError(data.error === 'session_expired'
          ? `This page has been open a while. Please refresh it and try again, or text us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`
          : (data.error || `We could not send that. Please text us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`));
        return;
      }
      setStatus('done');
      if (onSubmitted) onSubmitted();
    } catch {
      setStatus('idle');
      setError(`We could not send that. Please text us at ${WAVES_SUPPORT_PHONE_DISPLAY}.`);
    }
  };

  const inputStyle = {
    width: '100%', padding: '12px 14px', borderRadius: 8,
    border: `1.5px solid ${COLORS.grayLight}`, fontSize: 16,
    color: COLORS.navy, background: '#fff', boxSizing: 'border-box',
  };
  const labelStyle = {
    fontSize: 14, fontWeight: 500, color: COLORS.slate600, display: 'block', marginBottom: 6,
  };

  return (
    <section
      data-testid="cant-find-time"
      aria-labelledby="cant-find-time-heading"
      data-glass="soft"
      style={{
        position: 'relative',
        background: COLORS.white,
        border: `${zeroTimes ? 2 : 1}px solid ${zeroTimes ? COLORS.wavesBlue : COLORS.slate200}`,
        borderRadius: 12, padding: 16, marginTop: 20,
      }}
    >
      <h2 id="cant-find-time-heading" style={{ fontSize: 18, fontWeight: 600, color: COLORS.glassNavy, margin: '0 0 6px', letterSpacing: '-0.3px' }}>
        Can't find a time that works?
      </h2>
      <p style={{ fontSize: 16, color: COLORS.slate600, margin: '0 0 12px', lineHeight: 1.5 }}>
        Text our team and we'll fit you in.
      </p>
      <Button
        as="a"
        variant={zeroTimes ? 'primary' : 'secondary'}
        href={WAVES_SUPPORT_SMS_TEL}
        style={{ display: 'inline-block', textAlign: 'center' }}
      >
        Text us at {WAVES_SUPPORT_PHONE_DISPLAY}
      </Button>

      {status === 'done' ? (
        <div role="status" style={{ marginTop: 16, fontSize: 16, fontWeight: 600, color: COLORS.glassNavy, lineHeight: 1.5 }}>
          Got it — our team will text you to set a time.
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          {!open ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              style={{
                background: 'transparent', border: 'none', padding: 0,
                color: COLORS.wavesBlue, fontSize: 15, fontWeight: 700, cursor: 'pointer', textDecoration: 'underline',
              }}
            >
              Or tell us your preferred day and time
            </button>
          ) : (
            <form onSubmit={submit} noValidate>
              <h3 style={{ fontSize: 16, fontWeight: 600, color: COLORS.glassNavy, margin: '0 0 12px' }}>
                Tell us your preferred day and time
              </h3>

              <div style={{ marginBottom: 12 }}>
                <label htmlFor="ptr-name" style={labelStyle}>Your name</label>
                <input id="ptr-name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="waves-focus-ring" style={inputStyle} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label htmlFor="ptr-phone" style={labelStyle}>Mobile phone</label>
                <input id="ptr-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="waves-focus-ring" style={inputStyle} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label htmlFor="ptr-date" style={labelStyle}>Preferred day</label>
                <input id="ptr-date" type="date" min={min} max={max} value={preferredDate} onChange={(e) => setPreferredDate(e.target.value)} className="waves-focus-ring" style={inputStyle} />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label htmlFor="ptr-date2" style={labelStyle}>Second choice (optional)</label>
                <input id="ptr-date2" type="date" min={min} max={max} value={secondDate} onChange={(e) => setSecondDate(e.target.value)} className="waves-focus-ring" style={inputStyle} />
              </div>

              <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
                <legend style={labelStyle}>Time of day</legend>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {TIME_OF_DAY.map((opt) => (
                    <label
                      key={opt.id}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                        padding: '10px 14px', borderRadius: 999, fontSize: 15,
                        border: `1.5px solid ${timeOfDay === opt.id ? COLORS.wavesBlue : COLORS.grayLight}`,
                        background: timeOfDay === opt.id ? '#F0F9FF' : '#fff', color: COLORS.navy,
                      }}
                    >
                      <input
                        type="radio"
                        name="ptr-time-of-day"
                        value={opt.id}
                        checked={timeOfDay === opt.id}
                        onChange={() => setTimeOfDay(opt.id)}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div style={{ marginBottom: 12 }}>
                <label htmlFor="ptr-note" style={labelStyle}>Anything else we should know? (optional)</label>
                <textarea id="ptr-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className="waves-focus-ring" style={{ ...inputStyle, resize: 'vertical' }} />
              </div>

              {/* Honeypot: off-screen, out of the tab order, ignored by assistive tech. */}
              <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, overflow: 'hidden' }}>
                <label htmlFor="ptr-website">Website</label>
                <input id="ptr-website" type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
              </div>

              {error && (
                <div role="alert" style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 10, padding: 12, fontSize: 14, color: '#991B1B', marginBottom: 12 }}>
                  {error}
                </div>
              )}

              <Button type="submit" variant="primary" disabled={status === 'sending'} style={{ width: '100%' }}>
                {status === 'sending' ? 'Sending…' : 'Send request'}
              </Button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
