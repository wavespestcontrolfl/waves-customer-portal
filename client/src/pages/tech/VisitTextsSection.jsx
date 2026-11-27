// Visit Brief section: "Customer texts · last 7 days" (GATE_TECH_VISIT_TEXTS, owner 2026-11-26).
// One read of GET /admin/schedule/:id/visit-texts, which the server scopes to the technician's own visit. Gate off
// (404), no texts and no hidden count render nothing; a failed read renders one muted line, never a banner.
// Photos are short-lived signed links the server mints for this request; they open full size in a new tab.
import { useEffect, useRef, useState } from 'react';
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

// The server signs the photo links for one hour. They are read again before that ends, and when a locked phone or a
// background tab wakes up past that point the stale links are withheld at once and read again (as the Visit Brief's
// visit-prep photos do), so a tap never opens an expired link.
const REFRESH_MS = 50 * 60 * 1000;

// `key` names the visit the texts belong to: its id, its customer and its date. A change of any of them (a merge, a reschedule
// pushed to the open screen) clears what is shown at once and reads again.
function useVisitTexts(serviceId, query, key, enabled, request) {
  const [state, setState] = useState({ key: null, data: null, failed: false, at: 0 });
  const [tick, setTick] = useState(0);
  const atRef = useRef(0);
  atRef.current = state.at;
  useEffect(() => {
    if (!enabled || !query || typeof request !== 'function') return undefined;
    let live = true;
    Promise.resolve(request(`/admin/schedule/${serviceId}/visit-texts?${query}`))
      .then((data) => { if (live) setState({ key, data, failed: false, at: Date.now() }); })
      // 404 is the gate off or a visit that is not his: show nothing. Any other failure gets one muted line.
      .catch((err) => { if (live) setState({ key, data: null, failed: err?.status !== 404, at: Date.now() }); });
    const refresh = setTimeout(() => setTick((n) => n + 1), REFRESH_MS);
    return () => { live = false; clearTimeout(refresh); };
  }, [enabled, serviceId, query, key, request, tick]);
  useEffect(() => {
    if (!enabled) return undefined;
    const onResume = () => {
      if (document.visibilityState === 'hidden' || !atRef.current || Date.now() - atRef.current < REFRESH_MS) return;
      setState((prev) => ({ ...prev, key: null, data: null, at: 0 }));
      setTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('focus', onResume);
    return () => { document.removeEventListener('visibilitychange', onResume); window.removeEventListener('focus', onResume); };
  }, [enabled]);
  return state;
}

// The photos the server did not sign (the photo switch is off, or one failed): counted, never left as a silent gap.
function PhotosNotShown({ missing }) {
  if (!(missing > 0)) return null;
  return <p style={mutedStyle}>{missing} {missing === 1 ? 'photo is' : 'photos are'} not shown. Ask the office.</p>;
}

// `byService` is the panel's per-visit brief map: the brief answer carries `visitTexts: true` while the gate is on, and
// only then is the read made. The loaded answer is stored with the visit it was read for and shown only for that visit.
// The visit this screen shows: its id, customer and date. The request names the customer and date, and the server answers only while
// they are still the visit's. Without both there is nothing to name, so nothing is read.
function visitIdentity(service) {
  const customerId = String(service.customer_id || service.customerId || '');
  const scheduledDate = String(service.scheduledDate || service.scheduled_date || '').slice(0, 10);
  const query = customerId && scheduledDate ? `customerId=${encodeURIComponent(customerId)}&scheduledDate=${encodeURIComponent(scheduledDate)}` : '';
  return { key: [service.id, customerId, scheduledDate].join('|'), query };
}

export default function VisitTextsSection({ service, byService, request }) {
  const serviceId = service.id;
  const { key, query } = visitIdentity(service);
  const enabled = byService?.[serviceId]?.brief?.visitTexts === true && Boolean(query);
  const state = useVisitTexts(serviceId, query, key, enabled, request);

  if (!enabled || state.key !== key) return null;
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
          <PhotosNotShown missing={(t.photoCount || 0) - (t.photos?.length || 0)} />
        </div>
      ))}
      {hidden > 0 && <p style={mutedStyle}>{hidden} {hidden === 1 ? 'text is' : 'texts are'} hidden. Ask the office.</p>}
    </div>
  );
}
