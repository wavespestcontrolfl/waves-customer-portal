/**
 * Waves app showcase — React port of the SSR estimate's transparency card
 * (PR #2060): real app screenshots in phone frames, the six trust features,
 * and store badges. The #1 switcher complaint is "never knew when techs
 * were coming or what got done" — this card answers it with the actual app.
 *
 * Store URLs mirror the server's WAVES_IOS_APP_URL / WAVES_ANDROID_APP_URL
 * envs (VITE_-prefixed for the client build, same defaults): a missing URL
 * renders that badge unlinked, and with neither URL set the card shows
 * "Coming soon to iPhone & Android".
 */
import { estimateCard } from './cardStyles';
import { glassCopyActive, GLASS_COPY } from '../../lib/estimate-glass-copy';
import { isNativeApp } from '../../native/platform';
import { W } from './tokens';


const APP_STORE_URL = import.meta.env.VITE_IOS_APP_URL
  || 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = import.meta.env.VITE_ANDROID_APP_URL
  || 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

const APP_SHOTS = [
  { src: '/images/app/app-tracking.webp', alt: 'Waves app visit screen with a live-GPS tech-en-route update before arrival', title: 'See your tech coming', caption: 'Live GPS, the hour before arrival' },
  { src: '/images/app/app-visits.webp', alt: 'Waves app Visits screen listing upcoming and completed service visits', title: 'Every visit & report', caption: 'Upcoming, past, and what we did' },
  { src: '/images/app/app-alerts.webp', alt: 'Waves app notification settings, with each alert set to text, email, or both', title: 'Alerts you control', caption: 'Text, email, or both' },
  { src: '/images/app/app-contacts.webp', alt: 'Waves app on-location contacts screen to add a spouse, tenant, or property manager', title: 'Loop in your family', caption: 'Spouse, tenant, or property manager' },
];

const FEATURE_ICONS = {
  pin: <><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z" /><circle cx="12" cy="10" r="2.6" /></>,
  chat: <path d="M21 11.5a8 8 0 0 1-11.5 7.2L4 20.5l1.8-4.4A8 8 0 1 1 21 11.5z" />,
  doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 13h6M9 17h4" /></>,
  family: <><circle cx="9" cy="8" r="3.2" /><path d="M3.2 19.2c0-3.4 2.8-5.6 5.8-5.6s5.8 2.2 5.8 5.6" /><path d="M16.2 5.4a3 3 0 0 1 0 5.8" /><path d="M17.4 13.8c2.6.4 4.4 2.4 4.4 5.4" /></>,
  card: <><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M3 10h18M6.5 14.5h4" /></>,
  cal: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></>,
};

const APP_FEATURES = [
  ['pin', 'Live tech tracking'],
  ['chat', 'Text your tech'],
  ['doc', 'Photo & video reports'],
  ['family', 'Add family to alerts'],
  ['card', 'Billing & autopay'],
  ['cal', 'Reschedule & history'],
];

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
  if (url) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={label} style={{ display: 'inline-flex', lineHeight: 0, borderRadius: 7 }}>
        {children}
      </a>
    );
  }
  return (
    <span role="img" aria-label={`${label} — coming soon`} style={{ display: 'inline-flex', lineHeight: 0, borderRadius: 7 }}>
      {children}
    </span>
  );
}

// onBookToday: scroll-to-booking callback — the "Book today!" CTA renders
// only when the page can actually self-book (omitted on accepted/terminal
// and review-before-booking states).
export default function AppShowcaseCard({ onBookToday = null }) {
  // Inside the native app the store badges are dead weight (and an App
  // Store review flag) — every other surface hides them via isNativeApp().
  if (isNativeApp()) return null;
  const anyStoreLive = !!(APP_STORE_URL || PLAY_STORE_URL);
  // Glass copy pack (PR B).
  const glass = glassCopyActive();
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
        {glass ? GLASS_COPY.appTitle : 'Watch every visit — right from your phone'}
      </h2>
      <p style={{ fontSize: 14, color: W.textCaption, margin: '0 0 16px', lineHeight: 1.5 }}>
        {glass
          ? GLASS_COPY.appExcerpt
          : 'Live GPS, visit reports, and alerts you control — the Waves app keeps you in the loop from booking to done.'}
      </p>

      {glass ? (
        <div className="gc-app-visual">
          <div className="gc-av-left">
            <div className="gc-av-glow" aria-hidden="true" />
            <img
              className="gc-av-phone"
              src="/images/app/app-tracking.webp"
              width="760"
              height="1647"
              loading="lazy"
              alt="Waves app live technician tracking"
              style={{ height: 'auto' }}
            />
          </div>
          <div className="gc-av-right">
            <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', color: W.navyDeep }}>
              It&rsquo;s all in the Waves app
            </div>
            <p style={{ fontSize: 14, color: W.textBody, margin: '8px 0 0', lineHeight: 1.5 }}>
              {GLASS_COPY.appHouseholdLine}
            </p>
            <div className="gc-av-chips">
              {APP_FEATURES.map(([, label]) => (
                <span key={label} className="gc-av-chip">{label}</span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', opacity: anyStoreLive ? 1 : 0.92 }}>
              {(APP_STORE_URL || !PLAY_STORE_URL) ? (
                <StoreBadge url={APP_STORE_URL} label="Download Waves on the App Store"><AppStoreBadge /></StoreBadge>
              ) : null}
              {(PLAY_STORE_URL || !APP_STORE_URL) ? (
                <StoreBadge url={PLAY_STORE_URL} label="Get Waves on Google Play"><GooglePlayBadge /></StoreBadge>
              ) : null}
              {!anyStoreLive ? (
                <span style={{ flexBasis: '100%', marginTop: -2, fontSize: 12, fontWeight: 600, color: W.blueDark, letterSpacing: '0.02em' }}>
                  Coming soon to iPhone &amp; Android
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 16, margin: '4px 0 20px' }}>
        {APP_SHOTS.map((shot) => (
          <figure key={shot.src} style={{ margin: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{
              background: W.blueDeeper, borderRadius: 22, padding: 5,
              boxShadow: '0 12px 26px rgba(15,23,42,.20), 0 3px 8px rgba(15,23,42,.12)',
            }}>
              <img
                src={shot.src}
                width="760"
                height="1647"
                loading="lazy"
                alt={shot.alt}
                style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 17, background: W.white }}
              />
            </div>
            <figcaption style={{ marginTop: 11 }}>
              <strong style={{ display: 'block', fontSize: 14, fontWeight: 700, lineHeight: 1.2, color: W.blueDeeper }}>{shot.title}</strong>
              <span style={{ display: 'block', marginTop: 2, fontSize: 13, fontWeight: 500, lineHeight: 1.35, color: W.textBody }}>{shot.caption}</span>
            </figcaption>
          </figure>
        ))}
      </div>
      )}

      {glass ? null : (
      <div style={{ marginTop: 16, padding: 16, borderRadius: 12, background: W.blueLight, border: '1px solid #CDEBFA' }}>
        <div style={{ marginBottom: 12 }}>
          <strong style={{ display: 'block', fontSize: 15, color: W.blueDeeper }}>It&rsquo;s all in the Waves app</strong>
          <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: W.textBody, lineHeight: 1.4 }}>
            {glass ? GLASS_COPY.appHouseholdLine : 'One login for your whole household — everything in one place.'}
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '12px 0 16px' }}>
          {APP_FEATURES.map(([icon, label]) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: 9,
              background: W.white, border: '1px solid #DCEAF3', borderRadius: 10, padding: '10px 11px',
            }}>
              <span style={{
                flex: '0 0 auto', width: 28, height: 28, borderRadius: 7,
                background: W.blueLight, color: W.blueDark,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  {FEATURE_ICONS[icon]}
                </svg>
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.25, color: W.blueDeeper }}>{label}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 2, opacity: anyStoreLive ? 1 : 0.92 }}>
          {(APP_STORE_URL || !PLAY_STORE_URL) ? (
            <StoreBadge url={APP_STORE_URL} label="Download Waves on the App Store"><AppStoreBadge /></StoreBadge>
          ) : null}
          {(PLAY_STORE_URL || !APP_STORE_URL) ? (
            <StoreBadge url={PLAY_STORE_URL} label="Get Waves on Google Play"><GooglePlayBadge /></StoreBadge>
          ) : null}
          {!anyStoreLive ? (
            <span style={{ flexBasis: '100%', marginTop: -2, fontSize: 12, fontWeight: 600, color: W.blueDark, letterSpacing: '0.02em' }}>
              Coming soon to iPhone &amp; Android
            </span>
          ) : null}
        </div>
      </div>
      )}

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
            {glass ? GLASS_COPY.ctaBook : 'Book today!'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
