import { useEffect, useState } from 'react';
import Icon from '../Icon';
import { BUTTON_BASE, COLORS as B, CUSTOMER_SECTION_LABEL } from '../../theme-brand';
import { CUSTOMER_SURFACE as SHELL } from '../../theme-customer';
import { YARD_WRAPPED_COPY as COPY } from './yardWrappedCopy';
import {
  businessNameOf, canCopyText, canShareText, copyYardWrapped, linesWithLabels, makePictureFile, shareYardWrapped,
} from './yardWrappedShare';

// =========================================================================
// Yard Wrapped: a WaveGuard member's year-in-review card on the Home tab.
// Dark behind GATE_YARD_WRAPPED on the server: GET /api/yard-wrapped answers
// { enabled: false } (gate off, outside Dec 1 - Jan 31 ET, not a member, under
// 3 visits). DashboardTab owns the read and its propertyScope echo check (like
// the misting card); anything but an enabled card renders nothing, so the
// Home tab is unchanged.
//
// The server owns every figure; this file only lays them out. All words live
// in yardWrappedCopy.js. Share: yardWrappedShare.js.
// =========================================================================

const DEFAULT_CARD = { background: '#FFFFFF', border: '1px solid #E7E2D7', borderRadius: 16, position: 'relative' };

const rowStyle = { display: 'grid', gap: 4, borderTop: `1px solid ${SHELL.border}`, paddingTop: 12 };
const labelStyle = { fontSize: 14, fontWeight: 600, color: SHELL.muted };
const valueStyle = { fontSize: 18, fontWeight: 700, color: B.glassNavy, lineHeight: 1.3 };
const noteStyle = { fontSize: 14, color: SHELL.muted, lineHeight: 1.4 };
const pillStyle = {
  borderRadius: 999, padding: '6px 12px', background: SHELL.soft, border: `1px solid ${SHELL.softBorder}`,
  fontSize: 14, fontWeight: 600, color: B.glassNavy, lineHeight: 1.2,
};
const buttonStyle = {
  ...BUTTON_BASE, letterSpacing: 0, background: B.glassNavy, color: '#fff', padding: '10px 18px',
  minHeight: 44, boxShadow: 'none', borderRadius: 8, fontSize: 16, fontWeight: 700,
};

function ShareControls({ data }) {
  const [status, setStatus] = useState('');
  const [picture, setPicture] = useState(null);
  // Draw the picture ahead of the tap: the share sheet must open inside the tap.
  useEffect(() => {
    let live = true;
    makePictureFile(data).then((file) => { if (live) setPicture(file); });
    return () => { live = false; };
  }, [data]);
  const sharing = canShareText();
  if (!sharing && !canCopyText()) return null;
  const onClick = async () => {
    if (sharing) {
      const result = await shareYardWrapped(data, picture);
      if (result !== 'failed') return;
    }
    setStatus((await copyYardWrapped(data)) ? COPY.copiedStatus : COPY.copyFailedStatus);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <button type="button" data-testid="yard-wrapped-share" onClick={onClick} style={buttonStyle}>
        {sharing ? COPY.shareButton : COPY.copyButton}
      </button>
      <span role="status" aria-live="polite" style={noteStyle}>{status}</span>
    </div>
  );
}

export function YardWrappedBody({ data, cardStyle = DEFAULT_CARD }) {
  const lines = linesWithLabels(data);
  const treatedFor = Array.isArray(data.treatedFor) ? data.treatedFor : [];
  return (
    <section data-glass="card" data-testid="yard-wrapped-card" style={{ ...cardStyle, padding: 20, display: 'grid', gap: 14 }}>
      <div data-glass="chip" style={CUSTOMER_SECTION_LABEL}><Icon name="sparkles" size={14} strokeWidth={2} />{COPY.kicker}</div>
      <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: B.glassNavy, lineHeight: 1.25 }}>{COPY.title(data.year)}</h2>

      <div>
        <div style={{ fontSize: 40, fontWeight: 700, color: B.glassNavy, lineHeight: 1.1 }} data-testid="yard-wrapped-visits">
          {COPY.visitsValue(data.visits.total)}
        </div>
        <div style={noteStyle}>{COPY.visitsNote(data.year)}</div>
        {lines.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '10px 0 0', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {lines.map((entry) => <li key={entry.line} style={pillStyle}>{entry.label} · {entry.count}</li>)}
          </ul>
        )}
      </div>

      {data.lawnScore && (
        <div style={rowStyle}>
          <div style={labelStyle}>{COPY.lawnLabel}</div>
          <div style={valueStyle}>{COPY.lawnValue(data.lawnScore.first, data.lawnScore.last)}</div>
          <div style={noteStyle}>{COPY.lawnNote(data.year)}</div>
        </div>
      )}

      {treatedFor.length > 0 && (
        <div style={rowStyle}>
          <div style={labelStyle}>{COPY.treatedLabel}</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {treatedFor.map((name) => <li key={name} style={pillStyle}>{name}</li>)}
          </ul>
        </div>
      )}

      {data.technicianFirstName && (
        <div style={rowStyle}>
          <div style={labelStyle}>{COPY.technicianLabel}</div>
          <div style={valueStyle}>{data.technicianFirstName}</div>
          <div style={noteStyle}>{COPY.technicianNote(data.year)}</div>
        </div>
      )}

      {data.photoUrl && (
        <img src={data.photoUrl} alt={COPY.photoAlt(data.year)} loading="lazy" style={{ width: '100%', borderRadius: 12, display: 'block', objectFit: 'cover', maxHeight: 280 }} />
      )}

      <div style={{ fontSize: 16, color: SHELL.body, lineHeight: 1.45 }}>{COPY.thanks(data.year)}</div>
      <ShareControls data={data} />
      <div style={noteStyle} data-testid="yard-wrapped-business">{businessNameOf(data)}</div>
    </section>
  );
}

export default function YardWrappedCard({ data = null, cardStyle }) {
  if (data?.enabled !== true) return null;
  return <YardWrappedBody data={data} cardStyle={cardStyle} />;
}
