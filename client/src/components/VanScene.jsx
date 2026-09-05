import { FONTS } from '../theme-brand';

// The "look for this van" scene (owner 2026-09-03): the wrapped Waves van
// pulling up to the customer's house, under the appointment header card and
// on the booking confirmation step. Renders only when the page payload
// affirms the GATE_VAN_SCENE flag (appointment: `vanScene`; booking config:
// `van_scene`) — the flag rides the existing responses, no extra fetch.
//
// Inline styles + data-glass markup, same as the flow pages that mount it.
// The render is a transparent cutout (client/public/brand/waves-van-rear.webp,
// rear three-quarter view, 1200px) — the one van asset for the portal.

const INK = '#04395E';
const BODY = '#3F4A65';
const GOLD_CHIP = {
  display: 'inline-flex', alignItems: 'center', gap: 8,
  padding: '10px 18px', borderRadius: 999,
  fontSize: 14, fontWeight: 600, color: '#1B2C5B', letterSpacing: '0.02em',
  fontVariantNumeric: 'tabular-nums',
  background: 'linear-gradient(135deg, rgba(255,222,120,.62), rgba(244,176,20,.46)), rgba(240,165,0,.38)',
  border: '1px solid rgba(255,238,180,.92)',
  boxShadow: '0 8px 22px rgba(180,110,0,.25), 0 0 26px rgba(240,165,0,.35), inset 0 1px 0 rgba(255,255,255,.6)',
};

const KEYFRAMES = `
@media (prefers-reduced-motion: no-preference) {
  .waves-van-scene img { animation: waves-van-arrive 1.3s cubic-bezier(.34,1.56,.64,1) both; }
  @keyframes waves-van-arrive { from { transform: translateX(14%); } to { transform: none; } }
}
`;

function HouseSvg() {
  return (
    <svg
      viewBox="0 0 86 78"
      aria-hidden="true"
      style={{ position: 'absolute', left: '7%', bottom: 34, width: 'clamp(56px, 13vw, 86px)', filter: 'drop-shadow(0 8px 14px rgba(4,57,94,.25))' }}
    >
      <path d="M43 4 4 36h10v38h58V36h10z" fill={INK} />
      <rect x="36" y="48" width="14" height="26" fill="#F4B014" />
      <rect x="18" y="44" width="12" height="12" fill="#bfe3f7" />
      <rect x="56" y="44" width="12" height="12" fill="#bfe3f7" />
    </svg>
  );
}

// title: the card's heading under the fixed eyebrow. stamp: the gold
// date·window chip. (Both pages keep their own technician block.)
export default function VanScene({ title, stamp, style }) {
  return (
    <section
      data-glass="card"
      className="waves-van-scene"
      aria-label="The Waves van"
      style={{
        position: 'relative', overflow: 'hidden', textAlign: 'center',
        padding: '24px 20px 22px', marginBottom: 16, borderRadius: 8,
        background: '#FFFFFF', border: '1px solid #E7E2D7',
        fontFamily: FONTS.body, color: BODY,
        ...style,
      }}
    >
      <style>{KEYFRAMES}</style>
      <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.08em', lineHeight: 1.2, color: BODY, textTransform: 'uppercase', marginBottom: 8 }}>
        Look for this van
      </div>
      {title ? (
        <div data-gt="h3x" style={{ fontSize: 22, fontWeight: 800, fontFamily: FONTS.heading, lineHeight: 1.25, color: INK }}>
          {title}
        </div>
      ) : null}
      {/* The road: house on the left, the van arriving from the right. */}
      <div style={{ position: 'relative', height: 'clamp(160px, 36vw, 240px)', margin: '6px -20px 0' }}>
        <HouseSvg />
        <div aria-hidden="true" style={{ position: 'absolute', left: 20, right: 20, bottom: 26, borderTop: '3px dashed rgba(4,57,94,.28)' }} />
        <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, background: 'linear-gradient(180deg, rgba(255,255,255,.35), rgba(255,255,255,.05))' }} />
        <img
          src="/brand/waves-van-rear.webp"
          alt="The blue Waves Pest Control van"
          width="1200"
          height="681"
          style={{ position: 'absolute', right: '3%', bottom: 22, width: 'min(370px, 62%)', height: 'auto', filter: 'drop-shadow(0 18px 14px rgba(4,57,94,.28))' }}
        />
      </div>
      {stamp ? (
        <div style={{ marginTop: -8 }}><span style={GOLD_CHIP}>{stamp}</span></div>
      ) : null}
    </section>
  );
}
