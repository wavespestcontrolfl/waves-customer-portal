// Standard pre-footer newsletter signup for the tokened glass surfaces
// (owner 2026-07-09): every glass page except /rate, /reschedule and /track
// carries this card above its BrandFooter. All signup behavior lives in
// NewsletterSignup (double-opt-in POST /api/public/newsletter/subscribe);
// this wrapper only supplies the glass card material and the shared copy.
// data-glass is inert without the glass theme — the white card is the
// non-glass fallback.
import NewsletterSignup from './NewsletterSignup';
import { CUSTOMER_SURFACE } from '../theme-customer';

export default function GlassNewsletterCard({ source }) {
  return (
    <div style={{ width: '100%', padding: '0 16px', boxSizing: 'border-box' }}>
    <section
      data-glass="card"
      aria-label="Waves newsletter signup"
      style={{
        background: '#fff',
        border: '1px solid #E7E2D7',
        borderRadius: 12,
        padding: 20,
        margin: '16px auto 0',
        width: '100%',
        maxWidth: 720,
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      {/* Eyebrow names the section so the card says what it is. */}
      <div data-gt="eyebrow" style={{
        fontSize: 12, fontWeight: 800, letterSpacing: '0.08em',
        textTransform: 'uppercase', color: CUSTOMER_SURFACE.muted,
        marginBottom: 8,
      }}>
        The Waves Newsletter
      </div>
      <NewsletterSignup
        variant="light"
        source={source}
        heading="Get the next issue in your inbox"
        blurb="Local SWFL events, seasonal pest tips, and the occasional deal - straight from the truck."
      />
    </section>
    </div>
  );
}
