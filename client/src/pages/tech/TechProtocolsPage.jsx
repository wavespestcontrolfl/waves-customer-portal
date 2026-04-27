// client/src/pages/tech/TechProtocolsPage.jsx
//
// Tech-portal protocol reference (/tech/protocols). Slim mobile viewer
// over existing /api/admin/protocols/* endpoints. Reading-only — same
// data the admin ProtocolReferenceTabV2 surfaces, just packaged for
// a phone in the field.
//
// The protocols middleware uses requireTechOrAdmin (admin-protocols.js
// line 5) so tech JWTs hit these routes directly with the same
// adminToken the rest of the tech portal uses.
//
// Three tabs:
//   - Photos: pest/weed/disease ID guide — context-aware via
//     /photos/relevant when serviceType is selected, otherwise the
//     full /photos list.
//   - Scripts: communication scripts for common scenarios.
//   - Equipment: pre-service checklists.
//
// Out of scope (future iterations):
//   - Seasonal pest index (/seasonal-index) — month-aware list of
//     pests in season. Useful but redundant with the photo filter.
//   - Programs (/programs) and product labels — deep drilldowns that
//     deserve their own surface.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { etParts } from '../../lib/timezone';

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
  amber: '#f59e0b',
};

const API = import.meta.env.VITE_API_URL || '';

const TABS = [
  { key: 'photos', label: 'ID Guide', icon: '📸' },
  { key: 'scripts', label: 'Scripts', icon: '💬' },
  { key: 'equipment', label: 'Equipment', icon: '🧰' },
];

const SERVICE_FILTERS = [
  { key: '', label: 'All' },
  { key: 'lawn', label: 'Lawn' },
  { key: 'pest', label: 'Pest' },
  { key: 'tree_shrub', label: 'Tree & Shrub' },
  { key: 'mosquito', label: 'Mosquito' },
  { key: 'termite', label: 'Termite' },
];

export default function TechProtocolsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('photos');
  const [serviceFilter, setServiceFilter] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // AbortController-scoped fetch — overlapping tab/filter switches on
  // a slow mobile network can resolve out of order; abort the prior
  // request before issuing a new one so an older response can't
  // overwrite items the user has since switched away from.
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setErr('');
    (async () => {
      try {
        const token = localStorage.getItem('adminToken');
        const headers = { Authorization: `Bearer ${token}` };

        let path;
        if (activeTab === 'photos') {
          // /photos/relevant filters by service line + month; /photos
          // returns the full unfiltered list. Use whichever matches the
          // tech's filter chip selection.
          //
          // ET month explicitly: server defaults month to
          // `new Date().getMonth() + 1` which is UTC on Railway. In
          // ET evenings near month boundaries that drifts forward and
          // the ID guide returns the wrong month's seasonal set.
          if (serviceFilter) {
            const month = etParts().month;
            path = `/api/admin/protocols/photos/relevant?serviceType=${encodeURIComponent(serviceFilter)}&month=${month}`;
          } else {
            path = `/api/admin/protocols/photos`;
          }
        } else if (activeTab === 'scripts') {
          path = serviceFilter
            ? `/api/admin/protocols/scripts?service_line=${encodeURIComponent(serviceFilter)}`
            : `/api/admin/protocols/scripts`;
        } else {
          path = serviceFilter
            ? `/api/admin/protocols/equipment?service_line=${encodeURIComponent(serviceFilter)}`
            : `/api/admin/protocols/equipment`;
        }

        const res = await fetch(`${API}${path}`, { headers, signal: ctrl.signal });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (ctrl.signal.aborted) return;
        setItems(data.photos || data.scripts || data.checklists || []);
      } catch (e) {
        // Aborted requests reach this branch; suppress them — the
        // newer request's pending state is what should win.
        if (e.name === 'AbortError') return;
        setErr(e.message || 'Failed to load');
        setItems([]);
      }
      if (!ctrl.signal.aborted) setLoading(false);
    })();
    return () => ctrl.abort();
  }, [activeTab, serviceFilter]);

  return (
    <div style={{ maxWidth: 480, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button onClick={() => navigate('/tech')} style={{
          background: 'transparent', border: `1px solid ${DARK.border}`,
          color: DARK.text, padding: '6px 10px', borderRadius: 8,
          fontSize: 12, cursor: 'pointer',
        }}>
          ← Back
        </button>
        <h1 style={{
          margin: 0, fontSize: 20, fontWeight: 700, color: DARK.text,
          fontFamily: "'Montserrat', sans-serif",
        }}>
          Protocols
        </h1>
      </div>

      {/* Tab strip */}
      <div style={{
        display: 'flex', gap: 6, marginBottom: 12, overflowX: 'auto',
        paddingBottom: 4,
      }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: '8px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: activeTab === t.key ? `${DARK.teal}22` : DARK.card,
              border: `1px solid ${activeTab === t.key ? DARK.teal : DARK.border}`,
              color: activeTab === t.key ? DARK.teal : DARK.text,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Service-line filter chips */}
      <div style={{
        display: 'flex', gap: 6, marginBottom: 14, overflowX: 'auto',
        paddingBottom: 4,
      }}>
        {SERVICE_FILTERS.map((f) => (
          <button
            key={f.key || 'all'}
            onClick={() => setServiceFilter(f.key)}
            style={{
              padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600,
              background: serviceFilter === f.key ? `${DARK.amber}22` : 'transparent',
              border: `1px solid ${serviceFilter === f.key ? DARK.amber : DARK.border}`,
              color: serviceFilter === f.key ? DARK.amber : DARK.muted,
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Body */}
      {loading ? (
        <p style={{ color: DARK.muted, fontSize: 13, textAlign: 'center', padding: 30 }}>
          Loading…
        </p>
      ) : err ? (
        <div style={{
          background: '#ef444422', border: '1px solid #ef4444',
          color: '#ef4444', padding: 12, borderRadius: 8, fontSize: 13,
        }}>
          {err}
        </div>
      ) : items.length === 0 ? (
        <p style={{ color: DARK.muted, fontSize: 13, textAlign: 'center', padding: 30 }}>
          No {activeTab} for this filter.
        </p>
      ) : activeTab === 'photos' ? (
        <PhotoGrid photos={items} />
      ) : activeTab === 'scripts' ? (
        <ScriptList scripts={items} />
      ) : (
        <EquipmentList checklists={items} />
      )}
    </div>
  );
}

function PhotoGrid({ photos }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {photos.map((p) => {
        // /photos/relevant returns photoUrl (camelCase); /photos returns
        // photo_url (snake_case from DB). Handle both shapes.
        const url = p.photoUrl || p.photo_url;
        return (
          <a key={p.id} href={url} target="_blank" rel="noopener noreferrer"
            style={{
              display: 'block', background: DARK.card,
              border: `1px solid ${DARK.border}`, borderRadius: 8,
              overflow: 'hidden', textDecoration: 'none',
            }}>
            {url && (
              <img src={url} alt={p.name}
                style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }} />
            )}
            <div style={{ padding: '6px 8px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: DARK.text,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.name}
              </div>
              <div style={{ fontSize: 10, color: DARK.muted, textTransform: 'capitalize' }}>
                {p.category}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

function ScriptList({ scripts }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {scripts.map((s) => (
        <div key={s.id} style={{
          background: DARK.card, border: `1px solid ${DARK.border}`,
          borderRadius: 10, padding: 12,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: DARK.text, textTransform: 'capitalize' }}>
              {s.scenario || s.title || 'Script'}
            </span>
            {s.service_line && (
              <span style={{
                fontSize: 10, color: DARK.muted, padding: '2px 6px',
                border: `1px solid ${DARK.border}`, borderRadius: 4,
                textTransform: 'capitalize',
              }}>
                {s.service_line.replace('_', ' ')}
              </span>
            )}
          </div>
          <p style={{ margin: 0, fontSize: 13, color: DARK.text, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {s.script_text || s.body || s.content}
          </p>
        </div>
      ))}
    </div>
  );
}

function EquipmentList({ checklists }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {checklists.map((c) => (
        <div key={c.id} style={{
          background: DARK.card, border: `1px solid ${DARK.border}`,
          borderRadius: 10, padding: 12,
        }}>
          <div style={{ marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: DARK.text, textTransform: 'capitalize' }}>
              {c.service_type || c.name}
            </span>
            {c.service_line && (
              <span style={{
                marginLeft: 6, fontSize: 10, color: DARK.muted,
                padding: '2px 6px', border: `1px solid ${DARK.border}`,
                borderRadius: 4, textTransform: 'capitalize',
              }}>
                {c.service_line.replace('_', ' ')}
              </span>
            )}
          </div>
          {Array.isArray(c.checklist_items) && c.checklist_items.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, color: DARK.text, fontSize: 13, lineHeight: 1.6 }}>
              {c.checklist_items.map((item, i) => (
                <li key={i}>{typeof item === 'string' ? item : item.label || item.name || JSON.stringify(item)}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
