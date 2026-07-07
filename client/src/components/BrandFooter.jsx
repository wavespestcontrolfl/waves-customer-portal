import { COLORS as B, FONTS } from '../theme-brand';
import { CUSTOMER_SURFACE } from '../theme-customer';
import { WAVES_ADDRESS_LINE, WAVES_FL_LICENSE_LINE } from '../constants/business';
import { isNativeApp } from '../native/platform';
import { useWavesShell } from './brand/WavesShellContext';
import { glassCopyActive, GLASS_FOOTER_CITY_LINKS } from '../lib/estimate-glass-copy';

const GBP_LOCATION_LINKS = [
  { label: 'Lakewood Ranch', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Lakewood%20Ranch&query_place_id=ChIJVbBOKGYyTCgRVFz8_lu61Mw' },
  { label: 'Parrish', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Parrish&query_place_id=ChIJM32aQRIlw4gRr7goqhbAVpw' },
  { label: 'Sarasota', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Sarasota&query_place_id=ChIJeT_63_Y5w4gRGTNLozgSmdw' },
  { label: 'Venice', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Venice&query_place_id=ChIJ81vmrblZw4gRREDmlDUpq0E' },
];

function ServiceAreaLinks({ color }) {
  return (
    <>
      {GBP_LOCATION_LINKS.map((location, index) => (
        <span key={location.label}>
          {index > 0 && <span aria-hidden="true"> · </span>}
          <a
            href={location.href}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            {location.label}
          </a>
        </span>
      ))}
    </>
  );
}

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const CONTACT_PHONE_DISPLAY = '(941) 297-5749';
const CONTACT_PHONE_TEL = '+19412975749';
// Same URLs the quote wizard's consent line links to.
const PRIVACY_URL = 'https://wavespestcontrol.com/privacy-policy/';
const TERMS_URL = 'https://wavespestcontrol.com/terms-of-service/';

// Glass type-system colors (glass-theme.css tokens, mirrored here because
// the footer renders identically whether or not the theme is mounted).
const GLASS_INK = '#04395E';
const GLASS_BODY = 'rgba(12, 21, 40, 0.7)';
const GLASS_MUTED = 'rgba(12, 21, 40, 0.52)';

const SOCIAL_ICON_PATHS = [
  { name: 'Facebook', url: 'https://facebook.com/wavespestcontrol', path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z' },
  { name: 'Instagram', url: 'https://instagram.com/wavespestcontrol', path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948s-.014-3.667-.072-4.947c-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z' },
  { name: 'YouTube', url: 'https://youtube.com/@wavespestcontrol', path: 'M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  { name: 'TikTok', url: 'https://tiktok.com/@wavespestcontrol', path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  { name: 'X', url: 'https://x.com/wavespest', path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' },
  { name: 'LinkedIn', url: 'https://linkedin.com/company/wavespestcontrol', path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
];

// Store badges in the footer render as brand-navy SVGs (owner spec
// 2026-07-06 — footer badges match the glass header blue; the SVG shapes
// mirror estimate/AppShowcaseCard's). URLs are the live store listings,
// same as the login/portal "Get the app" sections.
const APP_STORE_URL = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';

function AppStoreBadgeSvg({ fill }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="132" height="40" viewBox="0 0 132 40" role="img" aria-label="Download on the App Store" style={{ display: 'block', height: 32, width: 'auto' }}>
      <rect width="132" height="40" rx="7" fill={fill} />
      <path fill="#fff" transform="translate(12 8.5) scale(0.92)" d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      <text x="40" y="17" fill="#fff" fontFamily="Inter,Helvetica,Arial,sans-serif" fontSize="7.5" letterSpacing="0.2">Download on the</text>
      <text x="39" y="31" fill="#fff" fontFamily="Inter,Helvetica,Arial,sans-serif" fontSize="16.5" fontWeight="600">App Store</text>
    </svg>
  );
}

function GooglePlayBadgeSvg({ fill }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="135" height="40" viewBox="0 0 135 40" role="img" aria-label="Get it on Google Play" style={{ display: 'block', height: 32, width: 'auto' }}>
      <rect width="135" height="40" rx="7" fill={fill} />
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

function StoreBadges({ ctaColor }) {
  if (isNativeApp()) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, minWidth: 0, maxWidth: '100%' }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: ctaColor, fontFamily: FONTS.heading, lineHeight: 1.5, maxWidth: 320 }}>
        Track, pay, message — one tap.
      </div>
      {/* Badges sit side by side (owner: inline, not stacked); flexWrap
          stacks them only when the column is too narrow for both. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'center' }}>
        <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Download on the App Store" style={{ display: 'inline-block' }}>
          <AppStoreBadgeSvg fill={GLASS_INK} />
        </a>
        <a href={PLAY_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Get it on Google Play" style={{ display: 'inline-block' }}>
          <GooglePlayBadgeSvg fill={GLASS_INK} />
        </a>
      </div>
    </div>
  );
}

export default function BrandFooter({ borderColor, variant }) {
  // Standalone pages (no WavesShell → no TrustFooter strip) still need the
  // copyright/license line; shell pages get it from TrustFooter and skip it
  // here (the owner removed the duplicate).
  const { inShell } = useWavesShell();
  // Quiet transactional footer for customer money pages (estimates):
  // socials + contact + legal, matching the server-rendered estimate's
  // .site-footer. No newsletter signup — the reader is here to review a
  // quote, not to subscribe.
  if (variant === 'contact') {
    return (
      <div style={{
        textAlign: 'center', padding: '40px 20px 32px',
        borderTop: `1px solid ${borderColor || B.grayLight}`,
        background: CUSTOMER_SURFACE.page,
      }}>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 16 }}>
          {SOCIAL_ICON_PATHS.map(s => (
            <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" title={s.name} aria-label={s.name} style={{
              width: 36, height: 36, borderRadius: '50%',
              background: CUSTOMER_SURFACE.chrome, border: `1px solid ${CUSTOMER_SURFACE.border}`, color: B.navy,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              textDecoration: 'none',
            }}>
              <svg viewBox="0 0 24 24" width={16} height={16} fill="currentColor"><path d={s.path} /></svg>
            </a>
          ))}
        </div>
        {/* nowrap per link + explicit spaces around the separators (JSX emits
            none between elements) so narrow screens break between items,
            never inside an email or mid-phone-number. */}
        <div style={{ fontSize: 13, color: B.grayDark, marginBottom: 10 }}>
          <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: B.navy, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>{CONTACT_EMAIL}</a>
          {' '}<span aria-hidden="true" style={{ margin: '0 4px', color: B.grayMid }}>·</span>{' '}
          <a href={`tel:${CONTACT_PHONE_TEL}`} style={{ color: B.navy, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>{CONTACT_PHONE_DISPLAY}</a>
          {' '}<span aria-hidden="true" style={{ margin: '0 4px', color: B.grayMid }}>·</span>{' '}
          <a href="https://www.wavespestcontrol.com" target="_blank" rel="noopener noreferrer" style={{ color: B.navy, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>wavespestcontrol.com</a>
        </div>
        {/* Glass estimates (PR B) replace the single office address
            with the four GBP city profiles — service-area-first framing. */}
        {glassCopyActive() ? (
          <div style={{ fontSize: 13, color: B.grayDark, marginBottom: 10 }}>
            {GLASS_FOOTER_CITY_LINKS.map((city, index) => (
              <span key={city.label}>
                {index > 0 ? <span aria-hidden="true" style={{ margin: '0 4px', color: B.grayMid }}>·</span> : null}
                <a
                  href={city.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: B.navy, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}
                >
                  {city.label}
                </a>
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: B.grayDark, marginBottom: 10 }}>{WAVES_ADDRESS_LINE}</div>
        )}
        {/* One legal stack per page (owner 2026-07-06): shell pages get
            Privacy/Terms + copyright from TrustFooter, so the contact
            variant only carries them standalone (codex P2, PR #2439). */}
        {!inShell ? (
          <>
            <div style={{ fontSize: 13, color: B.grayDark, marginBottom: 8 }}>
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{ color: B.navy, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>Privacy Policy</a>
              {' '}<span aria-hidden="true" style={{ margin: '0 4px', color: B.grayMid }}>·</span>{' '}
              <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" style={{ color: B.navy, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' }}>Terms of Service</a>
            </div>
            <div style={{ fontSize: 12, color: B.grayDark }}>© {new Date().getFullYear()} Waves Pest Control, LLC. All rights reserved.</div>
          </>
        ) : null}
      </div>
    );
  }

  if (variant === 'document') {
    return (
      <div style={{
        textAlign: 'center', marginTop: 28, paddingTop: 18,
        borderTop: `1px solid ${borderColor || B.grayLight}`,
      }}>
        <img src="/waves-logo.png" alt="" style={{ height: 26, opacity: 0.62, marginBottom: 8 }} />
        <div style={{ fontSize: 13, fontWeight: 700, color: B.navy, fontFamily: FONTS.heading }}>Waves Pest Control, LLC</div>
        <div style={{ fontSize: 12, color: B.grayDark, marginTop: 5, lineHeight: 1.6 }}>Family-owned pest control and lawn care in Southwest Florida</div>
        <div style={{ fontSize: 12, color: B.grayDark, marginTop: 5, lineHeight: 1.6 }}>
          <ServiceAreaLinks color={B.grayDark} />
        </div>
        {/* Shell pages get the copyright from TrustFooter — the document
            sign-off keeps only the identity block there (codex P2, PR #2439). */}
        {!inShell ? (
          <div style={{ fontSize: 11, color: B.grayMid, marginTop: 10 }}>© {new Date().getFullYear()} Waves Pest Control, LLC. All rights reserved.</div>
        ) : null}
      </div>
    );
  }

  // Quiet identity footer (owner spec 2026-07-06): wordmark block + GBP city
  // links + socials only — no newsletter signup, no tagline. Colors mirror
  // the glass type system (glass-theme.css: --brand #04395E ink,
  // rgba(12,21,40,.7) body, rgba(12,21,40,.52) muted); the dark variant
  // keeps its light-on-dark equivalents.
  const onDark = variant === 'dark';
  const headingColor = onDark ? '#fff' : GLASS_INK;
  const bodyColor = onDark ? 'rgba(255,255,255,0.78)' : GLASS_BODY;
  const mutedColor = onDark ? 'rgba(255,255,255,0.55)' : GLASS_MUTED;
  const logoOpacity = onDark ? 0.85 : 0.6;
  const defaultBorder = onDark ? 'rgba(255,255,255,0.2)' : B.grayLight;
  const socialBg = onDark ? 'rgba(255,255,255,0.15)' : GLASS_INK;
  const socialFg = onDark ? B.yellow : '#fff';

  const socials = SOCIAL_ICON_PATHS;

  // One uniform vertical gap (10px, flex column) between every footer row —
  // socials, app CTA, badges, wordmark block, contact, cities. No copyright
  // line here; the legal line lives in WavesShell's TrustFooter.
  const sep = <span aria-hidden="true" style={{ margin: '0 6px', color: mutedColor }}>·</span>;
  // Small bullet between contact items (flex child, so no extra margins).
  const dot = <span aria-hidden="true" style={{ fontSize: 8, color: mutedColor, lineHeight: 1 }}>•</span>;
  const contactLink = { color: headingColor, textDecoration: 'none', fontWeight: 500, whiteSpace: 'nowrap' };

  return (
    // data-brand-footer: explicit anchor for EstimateGlassTheme's classify
    // walker — without it the walker's "All rights reserved" climb can reach
    // the shell root (© line lives in TrustFooter) and restyle the header.
    <div data-brand-footer="" style={{
      textAlign: 'center', marginTop: 32, padding: '20px 16px',
      borderTop: `1px solid ${borderColor || defaultBorder}`,
      fontFamily: FONTS.body,
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
    }}>
      {/* Order (owner spec 2026-07-06): identity → contact → cities →
          socials → app block → legal. */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: '100%' }}>
        <img src="/waves-logo.png" alt="" style={{ height: 28, opacity: logoOpacity }} />
        <div style={{ fontSize: 15, fontWeight: 700, color: headingColor, fontFamily: FONTS.heading, lineHeight: 1.4 }}>Waves Pest Control</div>
        {/* Tagline + cities match the contact links: same ink, weight 500. */}
        <div style={{ fontSize: 13, fontWeight: 500, color: headingColor, lineHeight: 1.4 }}>Family-owned pest control &amp; lawn care</div>
        {/* Contact row: one horizontal line — email • phone • site with small
            bullet separators, no underlines. Bullet + item form one nowrap
            unit so a wrap never strands a bullet at the end of a line. */}
        <div style={{
          display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center',
          columnGap: 10, rowGap: 4, fontSize: 13, color: bodyColor, lineHeight: 1.4, fontFamily: FONTS.body,
        }}>
          <a href={`mailto:${CONTACT_EMAIL}`} style={contactLink}>{CONTACT_EMAIL}</a>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
            {dot}
            <a href={`tel:${CONTACT_PHONE_TEL}`} style={contactLink}>{CONTACT_PHONE_DISPLAY}</a>
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
            {dot}
            <a href="https://www.wavespestcontrol.com" target="_blank" rel="noopener noreferrer" style={contactLink}>wavespestcontrol.com</a>
          </span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 500, color: headingColor, lineHeight: 1.4 }}>
          <ServiceAreaLinks color={headingColor} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: headingColor, fontFamily: FONTS.heading, lineHeight: 1.5 }}>
          Real jobs. Real results. Follow along.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        {socials.map(s => (
          <a key={s.name} href={s.url} target="_blank" rel="noopener noreferrer" title={s.name} aria-label={s.name} style={{
            width: 36, height: 36, borderRadius: '50%',
            background: socialBg, color: socialFg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            textDecoration: 'none',
          }}>
            <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor"><path d={s.path} /></svg>
          </a>
        ))}
        </div>
      </div>
      <StoreBadges ctaColor={headingColor} />
      {!inShell ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={contactLink}>Privacy Policy</a>
            {' '}{sep}{' '}
            <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" style={contactLink}>Terms of Service</a>
          </div>
          <div style={{ fontSize: 12, color: mutedColor, lineHeight: 1.6 }}>
            © {new Date().getFullYear()} Waves Pest Control, LLC. All rights reserved.
          </div>
          <div style={{ fontSize: 12, color: mutedColor, lineHeight: 1.6 }}>
            Licensed &amp; insured · {WAVES_FL_LICENSE_LINE}
          </div>
        </div>
      ) : null}
    </div>
  );
}
