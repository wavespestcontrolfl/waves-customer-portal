/**
 * /card/:token — the customer's digital business card (owner spec 2026-07-11).
 *
 * One liquid-glass card per customer, minted server-side on their first
 * completed visit and fronted by the tech on record: logo centered between
 * Text/Call pills, tech identity with share (referral link — never the
 * personal card token) and save-contact (vCard) glyphs, app + social links,
 * and a demoted, centered review ask at the foot — a Waves-themed inverted
 * QR (white dots on glass, logo center) targeting the /l short link that
 * resolves to the Google review page for the office nearest the customer.
 *
 * The review block hides itself for customers flagged has_left_google_review.
 * Apple Wallet is a follow-up PR (needs the Pass Type ID cert).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { SOCIAL_ICON_PATHS, APP_STORE_URL, PLAY_STORE_URL } from '../components/BrandFooter';
import { WAVES_FL_LICENSE_LINE } from '../constants/business';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

const NAVY = '#04395E';
const AQUA = '#9BD4EA';

// Apple glyph + Play triangle mirror the footer badge SVGs (BrandFooter.jsx)
// so the marks stay consistent across surfaces.
const APPLE_GLYPH_PATH = 'M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z';

/**
 * Inverted glass QR: real matrix (error-correction H) drawn as white rounded
 * dots on the frosted chip, custom rounded finder rings, and a white center
 * knockout carrying the Waves logo. Modern iOS/Android cameras read inverted
 * codes; email/print variants stay classic navy-on-white.
 */
function GlassQr({ value, size = 96 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !value) return;
    let qr;
    try {
      qr = QRCode.create(value, { errorCorrectionLevel: 'H' });
    } catch {
      return;
    }
    const n = qr.modules.size;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const px = size * dpr;
    canvas.width = px;
    canvas.height = px;
    // Spec-required 4-module quiet zone INSIDE the canvas — scanners enforce
    // it, and the chip padding alone doesn't count (Codex P2 #2588 r2).
    const QUIET = 4;
    const m = px / (n + QUIET * 2);
    const off = QUIET * m;
    const ctx = canvas.getContext('2d');
    const fg = 'rgba(255,255,255,0.94)';
    ctx.clearRect(0, 0, px, px);

    const rr = (x, y, w, h, r) => {
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
    };

    // Finder zones (7×7 + 1-module separator) render as styled rings below —
    // skip their dot-modules here.
    const inFinderZone = (r, c) =>
      (r < 8 && c < 8) || (r < 8 && c >= n - 8) || (r >= n - 8 && c < 8);

    ctx.fillStyle = fg;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (inFinderZone(r, c)) continue;
        if (!qr.modules.get(r, c)) continue;
        ctx.beginPath();
        ctx.arc(off + c * m + m / 2, off + r * m + m / 2, m * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const finder = (row, col) => {
      ctx.fillStyle = fg;
      rr(off + col * m, off + row * m, 7 * m, 7 * m, 2.2 * m);
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      rr(off + (col + 1) * m, off + (row + 1) * m, 5 * m, 5 * m, 1.5 * m);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      rr(off + (col + 2) * m, off + (row + 2) * m, 3 * m, 3 * m, m);
      ctx.fill();
    };
    finder(0, 0);
    finder(0, n - 7);
    finder(n - 7, 0);

    // Center knockout + logo (EC level H absorbs the occlusion).
    const w = px * 0.3;
    const cx = (px - w) / 2;
    ctx.globalCompositeOperation = 'destination-out';
    rr(cx - 6, cx - 6, w + 12, w + 12, (w + 12) * 0.28);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#FFFFFF';
    rr(cx - 3, cx - 3, w + 6, w + 6, (w + 6) * 0.26);
    ctx.fill();
    const logo = new Image();
    logo.onload = () => {
      try { ctx.drawImage(logo, cx, cx, w, w); } catch { /* decode edge */ }
    };
    logo.src = '/waves-logo.png';
  }, [value, size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: 'block' }}
      aria-label="Scan to review Waves Pest Control on Google"
    />
  );
}

const GLASS_MATERIAL = {
  background: 'rgba(255,255,255,0.14)',
  border: '1px solid rgba(255,255,255,0.32)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35)',
  backdropFilter: 'blur(20px) saturate(160%)',
  WebkitBackdropFilter: 'blur(20px) saturate(160%)',
  color: '#FFFFFF',
  textDecoration: 'none',
  cursor: 'pointer',
};

function ContactPill({ href, label, icon }) {
  return (
    <a className="wcard-tap" href={href} style={{
      ...GLASS_MATERIAL,
      display: 'flex', alignItems: 'center', gap: 6,
      borderRadius: 999, padding: '9px 13px',
      fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {icon}
      {label}
    </a>
  );
}

const PHONE_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M6.62 10.79c1.44 2.83 3.76 5.15 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" fill="currentColor" />
  </svg>
);

const SMS_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3C6.48 3 2 6.92 2 11.75c0 2.76 1.55 5.2 3.97 6.8-.1.98-.53 2.25-1.42 3.25 1.93-.14 3.5-1.03 4.53-1.83.93.23 1.9.35 2.92.35 5.52 0 10-3.92 10-8.75S17.52 3 12 3z" fill="currentColor" />
  </svg>
);

export default function CardPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading'); // loading | ready | missing
  const [copied, setCopied] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    fetch(`${API_BASE}/card/${token}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!alive) return;
        if (json) { setData(json); setStatus('ready'); } else setStatus('missing');
      })
      .catch(() => alive && setStatus('missing'));
    return () => { alive = false; };
  }, [token]);

  const techFirst = data?.tech?.firstName || null;
  const referralUrl = data?.referralUrl;

  const onShare = useCallback(async () => {
    if (!referralUrl) return;
    const text = techFirst
      ? `${techFirst} from Waves Pest Control takes care of our place — here's their card.`
      : 'Waves Pest Control takes care of our place — here’s their card.';
    if (navigator.share) {
      try { await navigator.share({ title: 'Waves Pest Control', text, url: referralUrl }); } catch { /* dismissed */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2400);
    } catch { /* clipboard denied */ }
  }, [referralUrl, techFirst]);

  const scene = {
    minHeight: '100vh',
    background: 'radial-gradient(130% 150% at 18% -10%, #0A5480 0%, #04395E 48%, #021D33 100%)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-start',
    padding: '48px 16px 64px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
  };

  if (status !== 'ready') {
    return (
      <div style={scene}>
        {status === 'missing' && (
          <div style={{
            ...GLASS_MATERIAL, cursor: 'default', borderRadius: 24,
            padding: '28px 26px', maxWidth: 420, textAlign: 'center', marginTop: 60,
          }}>
            <div style={{ fontSize: 18, fontWeight: 650, marginBottom: 6 }}>This card isn&rsquo;t available</div>
            <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.75)', lineHeight: 1.5 }}>
              The link may be incomplete. Reach us any time at{' '}
              <a href="https://wavespestcontrol.com" style={{ color: AQUA }}>wavespestcontrol.com</a>.
            </div>
          </div>
        )}
      </div>
    );
  }

  // Business layer is Eastern-only: pin the timezone so an evening ET
  // completion never renders as the next calendar day for a non-ET viewer.
  const firstVisit = data.firstVisitCompletedAt
    ? new Date(data.firstVisitCompletedAt).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
      })
    : null;
  const showReview = !!data.reviewUrl && !data.customer?.hasLeftGoogleReview;
  const techName = data.tech?.name || 'Waves Pest Control';
  const initials = techName.split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();

  return (
    <div style={scene}>
      <style>{`
        .wcard-tap { transition: transform 140ms ease, filter 140ms ease; }
        @media (prefers-reduced-motion: no-preference) {
          .wcard-tap:hover { filter: brightness(1.08); }
          .wcard-tap:active { transform: scale(0.97); }
        }
        .wcard-tap:focus-visible { outline: 2px solid ${AQUA}; outline-offset: 2px; }
      `}</style>

      <div style={{
        position: 'relative',
        width: 'min(378px, 100%)',
        borderRadius: 32,
        padding: '24px 22px 22px',
        background: 'linear-gradient(160deg, rgba(255,255,255,0.20) 0%, rgba(255,255,255,0.08) 55%, rgba(255,255,255,0.12) 100%)',
        border: '1px solid rgba(255,255,255,0.34)',
        boxShadow: '0 36px 90px rgba(1,16,28,0.55), 0 2px 10px rgba(1,16,28,0.30), inset 0 1px 0 rgba(255,255,255,0.46), inset 0 -1px 0 rgba(255,255,255,0.10)',
        backdropFilter: 'blur(28px) saturate(180%)',
        WebkitBackdropFilter: 'blur(28px) saturate(180%)',
        color: '#FFFFFF',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}>
        {/* Top row: Text — logo — Call */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8 }}>
          <div style={{ justifySelf: 'start' }}>
            <ContactPill
              href={`sms:${data.phone.e164}`}
              label={techFirst ? `Text ${techFirst}` : 'Text us'}
              icon={SMS_ICON}
            />
          </div>
          <img
            src="/waves-logo.png"
            alt="Waves Pest Control"
            style={{ height: 54, width: 54, objectFit: 'contain', justifySelf: 'center', filter: 'drop-shadow(0 2px 6px rgba(1,16,28,0.35))' }}
          />
          <div style={{ justifySelf: 'end' }}>
            <ContactPill
              href={`tel:${data.phone.e164}`}
              label={techFirst ? `Call ${techFirst}` : 'Call us'}
              icon={PHONE_ICON}
            />
          </div>
        </div>

        <div style={{ height: 1, background: 'rgba(255,255,255,0.16)' }} />

        {/* Tech identity + share/save */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
          {data.tech?.photoUrl && !photoFailed ? (
            <img
              src={data.tech.photoUrl}
              alt={techName}
              // no-referrer: external photo hosts (site CDN hotlink rules,
              // presigned S3) must never see the tokenized card URL, and
              // referer-gated hosts 403 otherwise. Initials on any failure.
              referrerPolicy="no-referrer"
              onError={() => setPhotoFailed(true)}
              style={{
                flex: 'none', width: 52, height: 52, borderRadius: 999,
                objectFit: 'cover', objectPosition: '50% 26%',
                border: '1px solid rgba(255,255,255,0.45)',
                boxShadow: '0 4px 12px rgba(1,16,28,0.35)',
              }}
            />
          ) : (
            <div style={{
              flex: 'none', width: 52, height: 52, borderRadius: 999,
              background: 'rgba(255,255,255,0.16)', border: '1px solid rgba(255,255,255,0.40)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 680,
            }}>{initials || 'W'}</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
            <div style={{ fontSize: 22, fontWeight: 680, letterSpacing: '-0.01em' }}>{techName}</div>
            <div style={{ fontSize: 14, color: AQUA }}>Your Waves technician</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="wcard-tap"
              onClick={onShare}
              aria-label="Share with a friend"
              title="Share"
              style={{ ...GLASS_MATERIAL, width: 40, height: 40, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', font: 'inherit' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 15V3" />
                <path d="m8 7 4-4 4 4" />
                <path d="M8.5 10H7a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-5a3 3 0 0 0-3-3h-1.5" />
              </svg>
            </button>
            <a
              className="wcard-tap"
              href={`${API_BASE}/card/${token}/contact.vcf`}
              aria-label="Save contact"
              title="Save contact"
              style={{ ...GLASS_MATERIAL, width: 40, height: 40, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3v11" />
                <path d="m8 10.5 4 4 4-4" />
                <path d="M4 17v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1" />
              </svg>
            </a>
          </div>
        </div>

        {(data.customer?.firstName || firstVisit) && (
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.72)', marginTop: -4 }}>
            {data.customer?.firstName ? `Prepared for ${data.customer.firstName}` : 'Your Waves card'}
            {firstVisit ? ` · First visit ${firstVisit}` : ''}
          </div>
        )}

        {/* Get the app */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, alignItems: 'center' }}>
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.70)' }}>Get the Waves app</div>
          <div style={{ display: 'flex', gap: 10, width: '100%' }}>
            <a className="wcard-tap" href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Download the Waves app on the App Store"
              style={{ ...GLASS_MATERIAL, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 13, padding: '9px 10px' }}>
              <svg width="20" height="24" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={APPLE_GLYPH_PATH} /></svg>
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.12, textAlign: 'left' }}>
                <span style={{ fontSize: 14, letterSpacing: '0.02em', opacity: 0.85, whiteSpace: 'nowrap' }}>Download on the</span>
                <span style={{ fontSize: 16, fontWeight: 640, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>App Store</span>
              </span>
            </a>
            <a className="wcard-tap" href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Get the Waves app on Google Play"
              style={{ ...GLASS_MATERIAL, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 13, padding: '9px 10px' }}>
              <svg width="19" height="21" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#00C3FF" d="M4 3 13 12 4 21Z" />
                <path fill="#00E676" d="M4 3 16.5 9.8 13 12Z" />
                <path fill="#FFD500" d="M16.5 9.8 20.5 12 16.5 14.2Z" />
                <path fill="#FF3D00" d="M13 12 16.5 14.2 4 21Z" />
              </svg>
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.12, textAlign: 'left' }}>
                <span style={{ fontSize: 14, letterSpacing: '0.06em', opacity: 0.85, whiteSpace: 'nowrap' }}>GET IT ON</span>
                <span style={{ fontSize: 16, fontWeight: 640, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>Google Play</span>
              </span>
            </a>
          </div>
        </div>

        {/* Socials */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: 9 }}>
          {SOCIAL_ICON_PATHS.map((s) => (
            <a
              key={s.name}
              className="wcard-tap"
              href={s.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Waves on ${s.name}`}
              title={s.name}
              style={{ ...GLASS_MATERIAL, width: 37, height: 37, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d={s.path} /></svg>
            </a>
          ))}
        </div>

        {/* Review — demoted, centered, personal */}
        {showReview && (
          <>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.16)' }} />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center', paddingTop: 2 }}>
              <span style={{ fontSize: 15, fontWeight: 620, color: 'rgba(255,255,255,0.88)' }}>
                {techFirst ? `Did ${techFirst} take good care of you?` : 'Did we take good care of you?'}
              </span>
              <div style={{
                background: 'rgba(255,255,255,0.09)',
                border: '1px solid rgba(255,255,255,0.24)',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.22)',
                borderRadius: 20,
                padding: 11,
              }}>
                <GlassQr value={data.reviewUrl} size={96} />
              </div>
              <a
                className="wcard-tap"
                href={data.reviewUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  fontSize: 15, fontWeight: 640, color: '#BFE3F5',
                  textDecoration: 'underline', textUnderlineOffset: 3,
                  textDecorationColor: 'rgba(191,227,245,0.5)',
                }}
              >
                Review us on Google&thinsp;↗
              </a>
            </div>
          </>
        )}

        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.60)', textAlign: 'center' }}>
          wavespestcontrol.com · {WAVES_FL_LICENSE_LINE}
        </div>

        {copied && (
          <div role="status" style={{
            position: 'absolute', left: '50%', bottom: -46, transform: 'translateX(-50%)',
            background: 'rgba(2,29,51,0.92)', color: '#FFFFFF', fontSize: 14,
            padding: '8px 14px', borderRadius: 999, whiteSpace: 'nowrap',
            border: '1px solid rgba(255,255,255,0.25)',
          }}>
            Referral link copied
          </div>
        )}
      </div>
    </div>
  );
}
