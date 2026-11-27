// Visit Brief section: "Customer texts · last 7 days" (GATE_TECH_VISIT_TEXTS, owner 2026-11-26).
// One read of GET /admin/schedule/:id/visit-texts, which the server scopes to the technician's own visit. Gate off
// (404), no texts and no hidden count render nothing; a failed read renders one muted line, never a banner.
// Photos are short-lived signed links the server mints for this request; they open full size in a new tab.
import { useEffect, useState } from 'react';
import { formatETDateTime } from '../../lib/timezone';

// Same tokens as VisitBriefPanel's DARK palette (resolved inside .tech-field).
const COLORS = {
  card: 'var(--tfx-card, #ffffff)',
  border: 'var(--tfx-border, #d6d3d1)',
  text: 'var(--tfx-text, #1c1917)',
  muted: 'var(--tfx-muted, #57534e)',
};
const labelStyle = { fontSize: 14, fontWeight: 500, lineHeight: 1.4, color: COLORS.text, margin: '16px 0 6px', fontFamily: "var(--tfx-font, 'Roboto', system-ui, sans-serif)" };
const mutedStyle = { fontSize: 14, color: COLORS.muted, margin: '3px 0 0' };

function whenLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return formatETDateTime(d, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function PhotoThumbs({ photos }) {
  if (!photos?.length) return null;
  return (
    <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
      {photos.map((photo) => (
        <button
          key={photo.url}
          type="button"
          onClick={() => window.open(photo.url, '_blank', 'noopener,noreferrer')}
          aria-label="Open customer photo"
          style={{ padding: 0, border: `1px solid ${COLORS.border}`, borderRadius: 6, background: 'transparent', cursor: 'pointer', lineHeight: 0 }}
        >
          <img src={photo.url} alt="Customer-sent photo" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 5, display: 'block' }} />
        </button>
      ))}
    </div>
  );
}

export default function VisitTextsSection({ serviceId, request }) {
  const [state, setState] = useState({ data: null, failed: false });
  useEffect(() => {
    if (!serviceId || typeof request !== 'function') return undefined;
    let live = true;
    Promise.resolve(request(`/admin/schedule/${serviceId}/visit-texts`))
      .then((data) => { if (live) setState({ data, failed: false }); })
      // 404 is the gate off or a visit that is not his: show nothing. Any other failure gets one muted line.
      .catch((err) => { if (live) setState({ data: null, failed: err?.status !== 404 }); });
    return () => { live = false; };
  }, [serviceId, request]);

  if (state.failed) return <p style={{ ...mutedStyle, marginTop: 10 }}>Couldn't load texts</p>;
  const data = state.data;
  if (!data?.enabled) return null;
  const texts = data.texts || [];
  const hidden = Number(data.hidden) || 0;
  if (!texts.length && !hidden) return null;
  return (
    <div data-testid="visit-texts">
      <div style={labelStyle}>Customer texts · last 7 days</div>
      {texts.map((t) => (
        <div key={t.id} style={{ marginBottom: 8 }}>
          <p style={mutedStyle}>{t.direction === 'inbound' ? 'Customer' : 'Office'} · {whenLabel(t.at)}</p>
          {t.body && <p style={{ fontSize: 14, color: COLORS.text, margin: '2px 0 0', whiteSpace: 'pre-wrap' }}>{t.body}</p>}
          <PhotoThumbs photos={t.photos} />
        </div>
      ))}
      {hidden > 0 && <p style={mutedStyle}>{hidden} {hidden === 1 ? 'text' : 'texts'} about billing {hidden === 1 ? 'is' : 'are'} hidden. Ask the office.</p>}
    </div>
  );
}
