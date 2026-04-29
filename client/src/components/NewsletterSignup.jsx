// Customer-facing newsletter signup form. Drop-in for the footer
// (BrandFooter) and any in-page placement (PortalPage Learn tab).
//
// Posts to the public POST /api/public/newsletter/subscribe — no auth.
// Honeypot field ('company') guards against the laziest spam bots; the
// route is also covered by the app-level express-rate-limit.
//
// Variant matches BrandFooter's `variant` prop:
//   'light' (default) — used on white / sand surfaces
//   'dark'            — used on navy / blue hero surfaces
//
// `source` is recorded against the subscriber row so the admin can
// segment by where the signup came from (footer / learn / etc.).
//
// Prior states the form can land in:
//   idle       — initial
//   loading    — POST in flight
//   pending    — server queued a confirmation email (double-opt-in)
//   resent     — confirmation email re-fired for an already-pending row
//   already    — server reported alreadySubscribed (already-active row)
//   error      — bad email or network/server failure
//
// Note: the success/resubbed states from the legacy single-opt-in flow
// are gone — the public path now requires double-opt-in, so the form
// can never land at status='active' directly. 'already' still happens
// for grandfathered rows that confirmed under the old flow.

import { useState } from 'react';
import { COLORS as B, FONTS } from '../theme-brand';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function NewsletterSignup({
  variant = 'light',
  source = 'public_form',
  heading = 'Get the Waves newsletter',
  blurb = 'Local SWFL events, seasonal pest tips, and the occasional deal — straight from the truck.',
  compact = false,
}) {
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState(''); // honeypot
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');

  const onDark = variant === 'dark';
  const headingColor = onDark ? '#fff' : B.blueDeeper;
  const blurbColor = onDark ? 'rgba(255,255,255,0.78)' : B.slate600;
  const fieldBg = onDark ? 'rgba(255,255,255,0.95)' : '#fff';
  const fieldBorder = onDark ? 'transparent' : B.grayLight;
  const fieldText = B.navy;
  const successFg = onDark ? B.yellow : B.green;
  const errorFg = onDark ? '#FFB4B4' : B.red;

  const submit = async (e) => {
    e.preventDefault();
    if (state === 'loading' || state === 'pending' || state === 'resent' || state === 'already') return;
    setError('');

    if (company.trim()) {
      // Bot tripped the honeypot — pretend pending, drop the request.
      // Same lock state as legitimate pending so the bot can't
      // distinguish.
      setState('pending');
      return;
    }
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setError('Enter a valid email address.');
      setState('error');
      return;
    }

    setState('loading');
    try {
      const res = await fetch(`${API_BASE}/public/newsletter/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmed, source }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (data.alreadySubscribed) setState('already');
      else if (data.resent) setState('resent');
      else setState('pending');
    } catch (err) {
      setError(err.message || 'Something went wrong. Try again in a moment.');
      setState('error');
    }
  };

  const message = {
    pending: "Almost there — check your inbox for a confirmation email.",
    resent: "We re-sent the confirmation. Check your inbox (and spam folder).",
    already: "You're already on the list — thanks for sticking with us.",
  }[state];

  const locked = state === 'pending' || state === 'resent' || state === 'already';

  return (
    <div style={{
      textAlign: 'center',
      maxWidth: compact ? 480 : 560,
      margin: '0 auto',
      padding: compact ? '4px 0' : '8px 0',
    }}>
      {heading && (
        <div style={{
          fontFamily: FONTS.heading,
          fontSize: compact ? 14 : 16,
          fontWeight: 700,
          color: headingColor,
          marginBottom: 6,
          letterSpacing: '0.01em',
        }}>{heading}</div>
      )}
      {blurb && !compact && (
        <div style={{
          fontFamily: FONTS.body,
          fontSize: 13,
          color: blurbColor,
          lineHeight: 1.5,
          marginBottom: 12,
        }}>{blurb}</div>
      )}

      <form
        onSubmit={submit}
        style={{
          display: 'flex',
          gap: 8,
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'stretch',
        }}
      >
        {/* honeypot — hidden from humans, attractive to bots */}
        <label style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }} aria-hidden="true">
          Company
          <input
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </label>

        <input
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          aria-label="Email address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={locked}
          style={{
            flex: '1 1 240px',
            minWidth: 0,
            height: 44,
            padding: '0 14px',
            fontFamily: FONTS.body,
            fontSize: 15,
            color: fieldText,
            background: fieldBg,
            border: `1px solid ${fieldBorder}`,
            borderRadius: 10,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={state === 'loading' || locked}
          style={{
            height: 44,
            padding: '0 20px',
            fontFamily: FONTS.ui,
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: B.blueDeeper,
            background: B.yellow,
            border: `2px solid ${B.blueDeeper}`,
            borderRadius: 10,
            cursor: state === 'loading' || locked ? 'default' : 'pointer',
            opacity: state === 'loading' || locked ? 0.7 : 1,
            whiteSpace: 'nowrap',
            transition: 'opacity 150ms ease-out',
          }}
        >
          {state === 'loading' ? 'Subscribing…' : 'Subscribe'}
        </button>
      </form>

      {(message || error) && (
        <div
          role="status"
          aria-live="polite"
          style={{
            marginTop: 10,
            fontSize: 12,
            fontFamily: FONTS.body,
            color: state === 'error' ? errorFg : successFg,
          }}
        >
          {state === 'error' ? error : message}
        </div>
      )}
    </div>
  );
}
