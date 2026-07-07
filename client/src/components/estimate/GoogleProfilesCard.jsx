/**
 * Google Business Profiles showcase — GBP proof section for the estimate
 * page. Four office tiles (Lakewood Ranch / Parrish / Sarasota / Venice),
 * each with the Google "G" mark, a 5-star row, and a link straight to that
 * office's Google Business Profile. Sits right after CustomerReviews so the
 * anonymous review quotes are immediately backed by the real, checkable
 * profiles. URLs mirror BrandFooter's GBP_LOCATION_LINKS exactly.
 */
import { estimateCard, estimateInnerBox } from './cardStyles';
import { W } from './tokens';


// Same query_place_id URLs as BrandFooter's GBP_LOCATION_LINKS.
const GBP_PROFILES = [
  { label: 'Lakewood Ranch', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Lakewood%20Ranch&query_place_id=ChIJVbBOKGYyTCgRVFz8_lu61Mw' },
  { label: 'Parrish', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Parrish&query_place_id=ChIJM32aQRIlw4gRr7goqhbAVpw' },
  { label: 'Sarasota', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Sarasota&query_place_id=ChIJeT_63_Y5w4gRGTNLozgSmdw' },
  { label: 'Venice', href: 'https://www.google.com/maps/search/?api=1&query=Waves%20Pest%20Control%20Venice&query_place_id=ChIJ81vmrblZw4gRREDmlDUpq0E' },
];

// Google "G" mark (same paths as GlassEstimateExtras' review marquee).
function GoogleG({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ display: 'block' }}>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function ProfileTile({ profile }) {
  return (
    <a
      href={profile.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Waves ${profile.label} — rated 5.0 on Google`}
      style={estimateInnerBox({
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 8, padding: '16px 12px', textAlign: 'center',
        textDecoration: 'none', cursor: 'pointer',
      })}
    >
      <GoogleG />
      <strong style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.2, color: W.blueDeeper }}>
        Waves {profile.label}
      </strong>
      {/* Google's own rating presentation: numeric rating, then amber stars
          (#FBBC04, the G-mark yellow), Roboto-adjacent gray text. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, lineHeight: 1 }}>
        <span style={{ fontSize: 13, fontWeight: 400, color: '#70757A', fontFamily: 'Roboto, Arial, sans-serif' }}>5.0</span>
        <span aria-hidden="true" style={{ color: '#FBBC04', fontSize: 14, letterSpacing: 1, lineHeight: 1 }}>
          ★★★★★
        </span>
      </span>
    </a>
  );
}

export default function GoogleProfilesCard() {
  return (
    <section style={estimateCard()}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: W.textCaption,
        textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 8,
      }}>
        Find us on Google
      </div>
      <h2 style={{
        fontSize: 24, fontWeight: 500, lineHeight: 1.2,
        color: W.blueDeeper, margin: '0 0 8px',
      }}>
        Rated 5 stars in every city we serve
      </h2>
      <p style={{ fontSize: 14, color: W.textCaption, margin: '0 0 16px', lineHeight: 1.5 }}>
        Four offices, four Google Business Profiles — every one of them 5 stars.
        Tap your city and read the reviews yourself.
      </p>
      <div style={{
        display: 'grid', gap: 12,
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
      }}>
        {GBP_PROFILES.map((profile) => (
          <ProfileTile key={profile.label} profile={profile} />
        ))}
      </div>
    </section>
  );
}
