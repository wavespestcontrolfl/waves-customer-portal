import { useEffect, useState } from 'react';
import { adminFetch } from '../../lib/adminFetch';

/**
 * CreateProjectModal — tech-facing form for creating a Project (inspection
 * or documentation-heavy job). Mirrors the dark tech palette; mobile-first.
 *
 * Flow: pick type → pick customer → fill type-specific findings → attach
 * photos → save as draft. Admin reviews + sends from the admin portal.
 */

const DARK = {
  bg: '#0f1923',
  card: '#1e293b',
  border: '#334155',
  teal: '#0ea5e9',
  text: '#e2e8f0',
  muted: '#94a3b8',
  green: '#10b981',
  red: '#ef4444',
};

const inputStyle = {
  width: '100%',
  background: DARK.bg,
  color: DARK.text,
  border: `1px solid ${DARK.border}`,
  borderRadius: 8,
  padding: '10px 12px',
  fontSize: 14,
  boxSizing: 'border-box',
  fontFamily: "'Nunito Sans', sans-serif",
};

const labelStyle = {
  display: 'block',
  fontSize: 12,
  fontWeight: 700,
  color: DARK.muted,
  textTransform: 'uppercase',
  letterSpacing: 1,
  marginBottom: 6,
};

export default function CreateProjectModal({ onClose, onCreated, defaultCustomerId, defaultServiceRecordId, defaultScheduledServiceId }) {
  const [typesRegistry, setTypesRegistry] = useState(null);
  const [projectType, setProjectType] = useState('');
  const [customerId, setCustomerId] = useState(defaultCustomerId || '');
  const [customerQuery, setCustomerQuery] = useState('');
  const [customerResults, setCustomerResults] = useState([]);
  const [customerLabel, setCustomerLabel] = useState('');
  const [title, setTitle] = useState('');
  const [findings, setFindings] = useState({});
  const [recommendations, setRecommendations] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Photo buffer — queued locally, uploaded after project is created.
  const [photoQueue, setPhotoQueue] = useState([]); // [{file, category, caption}]
  const [uploadProgress, setUploadProgress] = useState({ done: 0, total: 0 });

  useEffect(() => {
    adminFetch('/admin/projects/types')
      .then(r => r.json())
      .then(d => setTypesRegistry(d.types))
      .catch(() => setError('Could not load project types'));
  }, []);

  // Debounced customer search
  useEffect(() => {
    if (!customerQuery || customerQuery.length < 2) { setCustomerResults([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await adminFetch(`/admin/customers?search=${encodeURIComponent(customerQuery)}&limit=8`);
        const d = await r.json();
        const list = (d.customers || d || []).slice(0, 8);
        setCustomerResults(list);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [customerQuery]);

  const typeCfg = typesRegistry && projectType ? typesRegistry[projectType] : null;

  function handleFindingChange(key, value) {
    setFindings(prev => ({ ...prev, [key]: value }));
  }

  function queuePhoto(file, category) {
    setPhotoQueue(prev => [...prev, { file, category, caption: '', id: `q_${Date.now()}_${prev.length}` }]);
  }

  async function handleSave() {
    if (!projectType) return setError('Pick a project type');
    if (!customerId) return setError('Pick a customer');
    setSaving(true);
    setError(null);
    try {
      const r = await adminFetch('/admin/projects', {
        method: 'POST',
        body: {
          customer_id: customerId,
          project_type: projectType,
          title: title || null,
          findings,
          recommendations: recommendations || null,
          service_record_id: defaultServiceRecordId || null,
          scheduled_service_id: defaultScheduledServiceId || null,
        },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'Save failed');
      const projectId = data.project.id;

      // Upload queued photos one by one. Kept serial so a mid-upload failure
      // reports accurate progress; volume is typically small (5–30 photos).
      if (photoQueue.length) {
        setUploadProgress({ done: 0, total: photoQueue.length });
        for (let i = 0; i < photoQueue.length; i++) {
          const ph = photoQueue[i];
          const fd = new FormData();
          fd.append('photo', ph.file);
          if (ph.category) fd.append('category', ph.category);
          if (ph.caption) fd.append('caption', ph.caption);
          try {
            await adminFetch(`/admin/projects/${projectId}/photos`, { method: 'POST', body: fd, headers: {} });
          } catch { /* individual photo failure is non-fatal */ }
          setUploadProgress({ done: i + 1, total: photoQueue.length });
        }
      }

      if (onCreated) onCreated(data.project);
      onClose?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        overflowY: 'auto', padding: '12px 0',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose?.(); }}
    >
      <div style={{
        width: '100%', maxWidth: 520, margin: '0 12px',
        background: DARK.card, border: `1px solid ${DARK.border}`, borderRadius: 14,
        display: 'flex', flexDirection: 'column',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', borderBottom: `1px solid ${DARK.border}`,
        }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: DARK.text, fontFamily: "'Montserrat', sans-serif" }}>
              Create Project Report
            </div>
            <div style={{ fontSize: 11, color: DARK.muted, marginTop: 2 }}>
              Inspection or documentation-heavy job
            </div>
          </div>
          <button
            type="button"
            onClick={() => !saving && onClose?.()}
            aria-label="Close"
            style={{
              background: 'transparent', border: 'none', color: DARK.muted,
              fontSize: 24, cursor: 'pointer', padding: '4px 10px',
            }}
          >×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Project type */}
          <div>
            <label style={labelStyle}>Project type *</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {typesRegistry && Object.entries(typesRegistry).map(([key, cfg]) => {
                const active = projectType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setProjectType(key)}
                    style={{
                      padding: '10px 10px', borderRadius: 8, cursor: 'pointer',
                      background: active ? DARK.teal : DARK.bg,
                      color: active ? '#fff' : DARK.text,
                      border: `1px solid ${active ? DARK.teal : DARK.border}`,
                      fontSize: 12, fontWeight: 700, textAlign: 'left',
                    }}
                  >
                    {cfg.short || cfg.label}
                  </button>
                );
              })}
            </div>
            {typeCfg?.description && (
              <div style={{ fontSize: 11, color: DARK.muted, marginTop: 6 }}>{typeCfg.description}</div>
            )}
          </div>

          {/* Customer */}
          <div>
            <label style={labelStyle}>Customer *</label>
            {customerId ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 12px', background: DARK.bg, borderRadius: 8,
                border: `1px solid ${DARK.border}`,
              }}>
                <span style={{ fontSize: 13, color: DARK.text }}>{customerLabel || customerId}</span>
                <button
                  type="button"
                  onClick={() => { setCustomerId(''); setCustomerLabel(''); setCustomerQuery(''); }}
                  style={{ background: 'transparent', border: 'none', color: DARK.muted, fontSize: 12, cursor: 'pointer' }}
                >Change</button>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                  placeholder="Search by name, phone, or email"
                  style={inputStyle}
                />
                {customerResults.length > 0 && (
                  <div style={{
                    marginTop: 6, background: DARK.bg, borderRadius: 8,
                    border: `1px solid ${DARK.border}`, overflow: 'hidden',
                  }}>
                    {customerResults.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          setCustomerId(c.id);
                          setCustomerLabel(`${c.first_name || ''} ${c.last_name || ''} · ${c.phone || ''}`.trim());
                        }}
                        style={{
                          width: '100%', textAlign: 'left', background: 'transparent',
                          border: 'none', borderBottom: `1px solid ${DARK.border}`,
                          padding: '10px 12px', cursor: 'pointer', color: DARK.text,
                          fontSize: 13,
                        }}
                      >
                        <div style={{ fontWeight: 700 }}>{c.first_name} {c.last_name}</div>
                        <div style={{ fontSize: 11, color: DARK.muted }}>
                          {c.phone} {c.city ? `· ${c.city}` : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Type-specific fields */}
          {typeCfg && (
            <>
              <div>
                <label style={labelStyle}>Title (optional)</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={`${typeCfg.label} — ${new Date().toLocaleDateString()}`}
                  style={inputStyle}
                />
              </div>

              {typeCfg.findingsFields.map(field => (
                <div key={field.key}>
                  <label style={labelStyle}>{field.label}</label>
                  {field.type === 'select' ? (
                    <select
                      value={findings[field.key] || ''}
                      onChange={(e) => handleFindingChange(field.key, e.target.value)}
                      style={inputStyle}
                    >
                      <option value="">Select…</option>
                      {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  ) : field.type === 'textarea' ? (
                    <textarea
                      value={findings[field.key] || ''}
                      onChange={(e) => handleFindingChange(field.key, e.target.value)}
                      placeholder={field.placeholder || ''}
                      rows={3}
                      style={{ ...inputStyle, resize: 'vertical', minHeight: 72 }}
                    />
                  ) : (
                    <input
                      type="text"
                      value={findings[field.key] || ''}
                      onChange={(e) => handleFindingChange(field.key, e.target.value)}
                      placeholder={field.placeholder || ''}
                      style={inputStyle}
                    />
                  )}
                </div>
              ))}

              <div>
                <label style={labelStyle}>Recommendations / notes</label>
                <textarea
                  value={recommendations}
                  onChange={(e) => setRecommendations(e.target.value)}
                  rows={4}
                  placeholder="What should the customer know or do next?"
                  style={{ ...inputStyle, resize: 'vertical', minHeight: 96 }}
                />
              </div>

              {/* Photos */}
              <div>
                <label style={labelStyle}>Photos</label>
                <PhotoQueue
                  queue={photoQueue}
                  setQueue={setPhotoQueue}
                  categories={typeCfg.photoCategories}
                  onAdd={queuePhoto}
                />
              </div>
            </>
          )}

          {error && (
            <div style={{ padding: '8px 12px', background: `${DARK.red}22`, border: `1px solid ${DARK.red}`, borderRadius: 8, color: DARK.red, fontSize: 13 }}>
              {error}
            </div>
          )}

          {saving && uploadProgress.total > 0 && (
            <div style={{ fontSize: 12, color: DARK.muted }}>
              Uploading photos… {uploadProgress.done} / {uploadProgress.total}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 16px', borderTop: `1px solid ${DARK.border}`,
          display: 'flex', gap: 10, justifyContent: 'flex-end',
        }}>
          <button
            type="button"
            onClick={() => !saving && onClose?.()}
            disabled={saving}
            style={{
              padding: '10px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: 'transparent', border: `1px solid ${DARK.border}`,
              color: DARK.text, cursor: saving ? 'default' : 'pointer',
            }}
          >Cancel</button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !projectType || !customerId}
            style={{
              padding: '10px 18px', borderRadius: 8, fontSize: 13, fontWeight: 800,
              background: (!projectType || !customerId) ? DARK.muted : DARK.teal,
              color: '#fff', border: 'none',
              cursor: (saving || !projectType || !customerId) ? 'default' : 'pointer',
            }}
          >{saving ? 'Saving…' : 'Save Draft'}</button>
        </div>
      </div>
    </div>
  );
}

function PhotoQueue({ queue, setQueue, categories, onAdd }) {
  const [selectedCategory, setSelectedCategory] = useState(categories?.[0] || '');

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    files.forEach(f => onAdd(f, selectedCategory));
    e.target.value = '';
  }

  function updateItem(id, patch) {
    setQueue(q => q.map(item => item.id === id ? { ...item, ...patch } : item));
  }

  function removeItem(id) {
    setQueue(q => q.filter(item => item.id !== id));
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          style={{ ...inputStyle, flex: 1, padding: '8px 10px', fontSize: 12 }}
        >
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <label style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          padding: '8px 14px', borderRadius: 8, background: DARK.teal, color: '#fff',
          fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
        }}>
          + Add
          <input
            type="file"
            accept="image/*"
            multiple
            capture="environment"
            onChange={handleFiles}
            style={{ display: 'none' }}
          />
        </label>
      </div>

      {queue.length === 0 ? (
        <div style={{ fontSize: 11, color: DARK.muted, padding: '10px 0' }}>
          No photos yet — pick a category and tap Add.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {queue.map(item => (
            <div key={item.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderRadius: 6,
              background: DARK.bg, border: `1px solid ${DARK.border}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: DARK.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.file.name}
                </div>
                <div style={{ fontSize: 10, color: DARK.muted }}>
                  {item.category.replace(/_/g, ' ')} · {(item.file.size / 1024).toFixed(0)} KB
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeItem(item.id)}
                style={{
                  background: 'transparent', border: 'none', color: DARK.muted,
                  cursor: 'pointer', fontSize: 16, padding: '0 6px',
                }}
                aria-label="Remove"
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
