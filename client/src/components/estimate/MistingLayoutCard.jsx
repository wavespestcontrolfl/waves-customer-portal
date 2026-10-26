// "Proposed misting layout" on the customer estimate page (GATE_MISTING_LAYOUT_DESIGNER): the staff-drawn concept
// picture saved for this estimate, with mist animating from every nozzle over it, the counts, a legend, the pump
// notice when the load passes 60 and the concept note. It takes the satellite photo's place in the Waves AI card; when
// the picture fails to load the card calls onImageError and the page shows the satellite photo again.
// No prices: the layout never changes the quote.
import { useState } from 'react';
import { FONTS } from '../../theme-brand';
import { CUSTOMER_SURFACE } from '../../theme-customer';
import { MISTING_LEGEND_KEYS, mistingLayoutCountsLine } from '../../lib/mistingLayoutCounts';
import { pumpLoad, pumpNotice } from '../../lib/mistingLayoutLimits';
import { estimateInnerBox } from './cardStyles';
import { MISTING_SWATCH } from './MistingLegend';
import MistingSprayOverlay from './MistingSprayOverlay';
import { LAYOUT_MAP_HEIGHT, LAYOUT_MAP_WIDTH } from '../../lib/mistingLayoutPublic';
import { resolveApiAssetUrl } from '../../utils/apiAssetUrl';

export const MISTING_CONCEPT_NOTE = 'Concept layout — final placement at the design visit and install.';

export default function MistingLayoutCard({ layout, address, onImageError }) {
  const [loaded, setLoaded] = useState(false);
  const notice = pumpNotice(pumpLoad(layout.counts?.nozzles, layout.counts?.risers));
  return (
    <div data-testid="misting-layout-card">
      <h3 style={{ margin: '0 0 8px', fontFamily: FONTS.serif, fontSize: 20, fontWeight: 500, lineHeight: 1.25, color: CUSTOMER_SURFACE.text }}>
        Proposed misting layout
      </h3>
      <div style={estimateInnerBox({ padding: 6 })}>
        <div style={{ position: 'relative', width: '100%', aspectRatio: `${LAYOUT_MAP_WIDTH} / ${LAYOUT_MAP_HEIGHT}`, borderRadius: 8, overflow: 'hidden', background: '#F7F5EE' }}>
          <img
            src={resolveApiAssetUrl(layout.imageUrl)}
            alt={`Proposed misting layout for ${layout.address || address || 'your property'}`}
            onLoad={() => setLoaded(true)}
            onError={onImageError}
            style={{ position: 'absolute', inset: 0, display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
          />
          {layout.geometry ? <MistingSprayOverlay geometry={layout.geometry} ready={loaded} /> : null}
        </div>
      </div>
      <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.5, color: CUSTOMER_SURFACE.text }}>{mistingLayoutCountsLine(layout.counts)}</p>
      {notice ? (
        <p data-testid="misting-pump-notice" style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5, fontWeight: 700, color: notice.level === 'red' ? '#B91C1C' : '#92400E' }}>{notice.text}</p>
      ) : null}
      <ul data-testid="misting-legend" aria-label="Legend" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
        {MISTING_LEGEND_KEYS.map((k) => (
          <li key={k.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, lineHeight: 1.4, color: CUSTOMER_SURFACE.muted }}>
            <i aria-hidden="true" style={{ display: 'inline-block', flexShrink: 0, boxSizing: 'content-box', width: 8, height: 8, ...MISTING_SWATCH[k.key] }} />
            {k.label}
          </li>
        ))}
      </ul>
      <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.5, color: CUSTOMER_SURFACE.muted }}>{MISTING_CONCEPT_NOTE}</p>
    </div>
  );
}
