// "Roof points" on the customer estimate page (owner ruling 2026-11-20, choice 4A): the roof points the Waves technician
// confirmed, numbered on the county roof photo, with the same numbers in the list under it. It takes the satellite photo's
// place in the Waves AI card; when the photo fails to load the card calls onImageError and the page shows the satellite
// photo again. The points are frozen when the estimate is sent (server side), and the page prints exactly what it is given.
// No prices: the points never change the quote.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { estimateInnerBox } from './cardStyles';
import { resolveApiAssetUrl } from '../../utils/apiAssetUrl';
import { DOT_PX, spreadPins } from './roofPinSpread';

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

// Whether a roof points block can show: a photo and at least one point. The Waves AI card asks this before it swaps out
// the satellite photo, so the card never hides that photo for an empty block.
export const hasRoofPoints = (points) => Boolean(points?.imageUrl) && Array.isArray(points.pins) && points.pins.length > 0;

// The photo box width in px (0 until measured, or where the browser cannot measure): the spread needs it to know how many
// px a badge covers. A width of 0 means "unknown" and the badges stay on their true points. It is the layout width
// (offsetWidth), so the page's entry animation, which scales the card, does not change it.
function usePhotoWidth(shown) {
  const boxRef = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!shown || !el) return undefined;
    const measure = () => setWidth(el.offsetWidth || 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);
  return [boxRef, width];
}

export default function RoofPointsCard({ points, address, onImageError }) {
  const shown = hasRoofPoints(points);
  const [boxRef, photoWidth] = usePhotoWidth(shown);
  const pins = useMemo(() => (shown ? points.pins.slice().sort((a, b) => a.n - b.n) : []), [shown, points]);
  // Worked out again only when the points or the photo width change, not on every render of the page.
  const spread = useMemo(() => spreadPins(pins, photoWidth), [pins, photoWidth]);
  if (!shown) return null;
  const count = pins.length;
  // A called-out point: its badge moved off it, so it gets a dot at the true point and a line to the badge. The spread
  // keeps every badge clear of that dot.
  const leaders = pins.map((p, i) => ({ p, s: spread[i] })).filter(({ s }) => s.callout);
  return (
    <div data-testid="roof-points-card">
      <div style={estimateInnerBox({ padding: 6 })}>
        <div ref={boxRef} style={{ position: 'relative', width: '100%', maxWidth: 480, margin: '0 auto', aspectRatio: '1 / 1', borderRadius: 8, overflow: 'hidden', background: '#F7F5EE' }}>
          <img
            src={resolveApiAssetUrl(points.imageUrl)}
            alt={`Aerial photo of the roof at ${address || 'your property'}, with ${count} numbered ${count === 1 ? 'place' : 'places'} where rodents can get in`}
            onError={onImageError}
            style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
          />
          {leaders.length > 0 ? (
            <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {leaders.map(({ p, s }) => (
                <g key={p.n} data-testid="roof-point-leader">
                  <line x1={s.fromX * 100} y1={s.fromY * 100} x2={s.x * 100} y2={s.y * 100} stroke={CUSTOMER_SURFACE.text} strokeWidth="3.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                  <line x1={s.fromX * 100} y1={s.fromY * 100} x2={s.x * 100} y2={s.y * 100} stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                </g>
              ))}
            </svg>
          ) : null}
          {leaders.map(({ p, s }) => (
            <span
              key={p.n}
              data-testid="roof-point-dot"
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: percent(s.fromX),
                top: percent(s.fromY),
                transform: 'translate(-50%, -50%)',
                boxSizing: 'border-box',
                width: DOT_PX,
                height: DOT_PX,
                borderRadius: '50%',
                background: '#FFFFFF',
                border: `2px solid ${CUSTOMER_SURFACE.text}`,
                pointerEvents: 'none',
              }}
            />
          ))}
          {pins.map((p, i) => (
            <span
              key={p.n}
              data-testid="roof-point-pin"
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: percent(spread[i].x),
                top: percent(spread[i].y),
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
      {points.preview === true ? (
        <p data-testid="roof-points-preview-note" style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: CUSTOMER_SURFACE.muted }}>
          Staff preview: the customer sees these points after the next send.
        </p>
      ) : null}
    </div>
  );
}
