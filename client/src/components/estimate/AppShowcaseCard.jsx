/**
 * Waves app showcase — the estimate page's "get the app" card. One layout
 * only (owner ask 2026-07-09: the legacy four-iPhone-screenshot variant is
 * gone): two Android-style phone mocks (home dashboard front, Billing &
 * Auto Pay behind — owner 2026-07-07), the six trust features as gold
 * chips, the household line, and the store badges. The #1 switcher
 * complaint is "never knew when techs were coming or what got done" — this
 * card answers it with the actual app.
 *
 * Store URLs mirror the server's WAVES_IOS_APP_URL / WAVES_ANDROID_APP_URL
 * envs (VITE_-prefixed for the client build, same defaults). Both stores
 * are live (Play went live 2026-07-09, owner confirmed).
 */
import { estimateCard } from './cardStyles';
import { GLASS_COPY } from '../../lib/estimate-glass-copy';
import { isNativeApp } from '../../native/platform';
import { W } from './tokens';


const APP_STORE_URL = import.meta.env.VITE_IOS_APP_URL
  || 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = import.meta.env.VITE_ANDROID_APP_URL
  || 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

function AppStoreBadge() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="132" height="40" viewBox="0 0 132 40" role="img" aria-label="Download on the App Store" style={{ display: 'block', height: 40, width: 'auto' }}>
      <rect width="132" height="40" rx="7" fill="#000" />
      <rect x="0.75" y="0.75" width="130.5" height="38.5" rx="6.25" fill="none" stroke="#5A5A5A" />
      <path fill="#fff" transform="translate(12 8.5) scale(0.92)" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      <text x="40" y="17" fill="#fff" fontFamily="Inter,Helvetica,Arial,sans-serif" fontSize="7.5" letterSpacing="0.2">Download on the</text>
      <text x="39" y="31" fill="#fff" fontFamily="Inter,Helvetica,Arial,sans-serif" fontSize="16.5" fontWeight="600">App Store</text>
    </svg>
  );
}

function GooglePlayBadge() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="135" height="40" viewBox="0 0 135 40" role="img" aria-label="Get it on Google Play" style={{ display: 'block', height: 40, width: 'auto' }}>
      <rect width="135" height="40" rx="7" fill="#000" />
      <rect x="0.75" y="0.75" width="133.5" height="38.5" rx="6.25" fill="none" stroke="#5A5A5A" />
      <g transform="translate(11 9) scale(0.92)">
        <path fill="#00C3FF" d="M4 3 13 12 4 21Z" />
        <path fill="#00E676" d="M4 3 16.5 9.8 13 12Z" />
        <path fill="#FFD500" d="M16.5 9.8 20.5 12 16.5 14.2Z" />
        <path fill="#FF3D00" d="M13 12 16.5 14.2 4 21Z" />
      </g>
      <text x="40" y="17" fill="#fff" fontFamily="Inter,Helvetica,Arial,sans-serif" fontSize="7.5" letterSpacing="0.6">GET IT ON</text>
      <text x="39.5" y="31" fill="#fff" fontFamily="Inter,Helvetica,Arial,sans-serif" fontSize="16" fontWeight="600">Google Play</text>
    </svg>
  );
}

function StoreBadge({ url, label, children }) {
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" aria-label={label} style={{ display: 'inline-flex', lineHeight: 0, borderRadius: 7 }}>
      {children}
    </a>
  );
}

// Reused by the booked-success card (owner ask 2026-07-12: store badges
// under the app line) — one badge source, no duplicated SVGs.
export { AppStoreBadge, GooglePlayBadge, StoreBadge, APP_STORE_URL, PLAY_STORE_URL };

// onBookToday: scroll-to-booking callback — the "Book today!" CTA renders
// only when the page can actually self-book (omitted on accepted/terminal
// and review-before-booking states).
export default function AppShowcaseCard({ onBookToday = null }) {
  // Inside the native app the store badges are dead weight (and an App
  // Store review flag) — every other surface hides them via isNativeApp().
  // Only the badge row goes, though: the rest of the card (and especially
  // the "Book today!" CTA on self-bookable estimates) must stay.
  const native = isNativeApp();
  return (
    <section style={estimateCard()}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8,
      }}>
        The Waves app
      </div>
      <h2 style={{
        fontSize: 24, fontWeight: 500, lineHeight: 1.2,
        color: W.blueDeeper, margin: '0 0 8px',
      }}>
        {GLASS_COPY.appTitle}
      </h2>
      <p style={{ fontSize: 14, color: W.textCaption, margin: '0 0 16px', lineHeight: 1.5 }}>
        {GLASS_COPY.appExcerpt}
      </p>

      <div className="gc-app-visual">
        <div className="gc-av-left">
          <div className="gc-av-glow" aria-hidden="true" />
          {/* Two Android-style phones, two different in-app screens
              (owner 2026-07-07): the home dashboard up front, the
              Billing & Auto Pay screen behind. */}
          <figure className="gc-phone gc-phone--android">
            <span className="gc-phone-cam" aria-hidden="true" />
            <img
              src="/images/app/app-dashboard-glass.webp"
              width="780"
              height="1688"
              loading="lazy"
              alt="Waves app home screen with your plan, balance, and next visit"
            />
          </figure>
          <figure className="gc-phone gc-phone--android gc-phone--b">
            <span className="gc-phone-cam" aria-hidden="true" />
            <img
              src="/images/app/app-billing-glass.webp"
              width="780"
              height="1688"
              loading="lazy"
              alt="Waves app Billing screen with Auto Pay, saved card, and payment history"
            />
          </figure>
        </div>
        <div className="gc-av-right">
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: W.navyDeep }}>
            It&rsquo;s all in the Waves app
          </div>
          <p style={{ fontSize: 14, color: W.textBody, margin: '8px 0 0', lineHeight: 1.5 }}>
            {GLASS_COPY.appHouseholdLine}
          </p>
          {/* The six feature chips were removed (owner 2026-07-11) — the
              phones + household line carry the pitch. */}
          {native ? null : (
          /* Badges centered under the copy column (owner ask 07-07), always
             SIDE BY SIDE (owner 2026-07-09) — the pair is ~280px, so nowrap
             fits even a 390px phone; wrap made them stack in the narrow
             copy column. */
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', flexWrap: 'nowrap' }}>
            <StoreBadge url={APP_STORE_URL} label="Download Waves on the App Store"><AppStoreBadge /></StoreBadge>
            <StoreBadge url={PLAY_STORE_URL} label="Get Waves on Google Play"><GooglePlayBadge /></StoreBadge>
          </div>
          )}
        </div>
      </div>

      {onBookToday ? (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
          <button
            type="button"
            onClick={onBookToday}
            style={{
              minHeight: 44,
              minWidth: 220,
              padding: '0 24px',
              background: W.blueDeeper,
              color: W.white,
              border: 'none',
              borderRadius: 10,
              fontSize: 15,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            {GLASS_COPY.ctaBook}
          </button>
        </div>
      ) : null}
    </section>
  );
}
