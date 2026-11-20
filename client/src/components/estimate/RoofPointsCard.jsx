// "Roof points" on the customer estimate page (owner ruling 2026-11-20, choice 4A): the roof points the Waves technician
// confirmed, numbered on the county roof photo, with the same numbers in the list under it. It takes the satellite photo's
// place in the Waves AI card; when the photo fails to load the card calls onImageError and the page shows the satellite
// photo again. The points are frozen when the estimate is sent (server side), and the page prints exactly what it is given.
// No prices: the points never change the quote.
import { FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { estimateInnerBox } from './cardStyles';
import { resolveApiAssetUrl } from '../../utils/apiAssetUrl';

const unit = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
};
const percent = (v) => `${Math.round(unit(v) * 10000) / 100}%`;

export function roofPointsLead(count) {
  return count === 1
    ? 'Your Waves technician found 1 place where rodents can get into your roof.'
    : `Your Waves technician found ${count} places where rodents can get into your roof.`;
}

export default function RoofPointsCard({ points, address, onImageError }) {
  const pins = (Array.isArray(points?.pins) ? points.pins : []).slice().sort((a, b) => a.n - b.n);
  if (!points?.imageUrl || !pins.length) return null;
  const count = pins.length;
  return (
    <div data-testid="roof-points-card">
      <div style={estimateInnerBox({ padding: 6 })}>
        <div style={{ position: 'relative', width: '100%', maxWidth: 480, margin: '0 auto', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: '#F7F5EE' }}>
          <img
            src={resolveApiAssetUrl(points.imageUrl)}
            alt={`Aerial photo of the roof at ${address || 'your property'}, with ${count} numbered ${count === 1 ? 'place' : 'places'} where rodents can get in`}
            onError={onImageError}
            style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
          />
          {pins.map((p) => (
            <span
              key={p.n}
              data-testid="roof-point-pin"
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: percent(p.x),
                top: percent(p.y),
                transform: 'translate(-50%, -50%)',
                boxSizing: 'border-box',
                width: 26,
                height: 26,
                borderRadius: '50%',
                background: CUSTOMER_SURFACE.text,
                color: '#FFFFFF',
                border: '2px solid #FFFFFF',
                boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
                fontSize: 14,
                fontWeight: 700,
                lineHeight: '22px',
                textAlign: 'center',
                fontFamily: FONTS.body,
              }}
            >
              {p.n}
            </span>
          ))}
        </div>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.5, fontWeight: 600, color: CUSTOMER_SURFACE.text }}>{roofPointsLead(count)}</p>
      <p style={{ margin: '2px 0 0', fontSize: 14, lineHeight: 1.5, color: CUSTOMER_SURFACE.body }}>The numbers match the list below.</p>
      <ol data-testid="roof-points-list" style={{ margin: '6px 0 0', paddingLeft: 22, fontSize: 14, lineHeight: 1.5, color: CUSTOMER_SURFACE.body }}>
        {pins.map((p) => (
          <li key={p.n} value={p.n}>{p.action ? `${p.label}: ${p.action}` : p.label}</li>
        ))}
      </ol>
      {points.imageYear ? (
        <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: CUSTOMER_SURFACE.muted }}>Photo: county aerial, {points.imageYear}.</p>
      ) : null}
    </div>
  );
}
