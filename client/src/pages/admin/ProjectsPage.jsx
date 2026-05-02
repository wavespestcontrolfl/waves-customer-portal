import { useEffect, useState, useCallback } from 'react';
import { adminFetch } from '../../lib/adminFetch';
import CreateProjectModal from '../../components/tech/CreateProjectModal';

/**
 * Projects — post-service inspection / documentation reports.
 *
 * Tier 2 light zinc palette. Techs create drafts from /tech; admin reviews,
 * edits findings, manages photos, and presses Send to generate the
 * customer-facing /report/project/:token link.
 */

const D = {
  bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7',
  heading: '#09090B', text: '#27272A', muted: '#71717A',
  accent: '#18181B', accentHover: '#27272A',
  success: '#15803D', amber: '#A16207', red: '#991B1B',
  inputBorder: '#D4D4D8', pill: '#F4F4F5',
};

const MONO = "'JetBrains Mono', monospace";

const STATUS_STYLES = {
  draft: { bg: '#FEF3C7', fg: '#92400E', label: 'Draft' },
  sent: { bg: '#DCFCE7', fg: '#166534', label: 'Sent' },
  closed: { bg: '#E4E4E7', fg: '#52525B', label: 'Closed' },
};

const TYPE_LABELS = {
  wdo_inspection: 'WDO',
  termite_inspection: 'Termite',
  pest_inspection: 'Pest',
  rodent_exclusion: 'Rodent',
  bed_bug: 'Bed Bug',
};
const WDO_TYPE = 'wdo_inspection';
const GENERAL_TYPE_LABELS = Object.fromEntries(
  Object.entries(TYPE_LABELS).filter(([key]) => key !== WDO_TYPE)
);
const GENERAL_PROJECT_TYPES = Object.keys(GENERAL_TYPE_LABELS);

function mergeProjectsUnique(...lists) {
  const byId = new Map();
  lists.flat().forEach(p => {
    if (p?.id && !byId.has(p.id)) byId.set(p.id, p);
  });
  return Array.from(byId.values());
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterType, setFilterType] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [typesRegistry, setTypesRegistry] = useState(null);
  const [createMode, setCreateMode] = useState(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filterStatus) qs.set('status', filterStatus);
    const wdoQs = new URLSearchParams(qs);
    wdoQs.set('project_type', WDO_TYPE);
    try {
      if (filterType) {
        const generalQs = new URLSearchParams(qs);
        generalQs.set('project_type', filterType);
        const [generalRes, wdoRes] = await Promise.all([
          adminFetch(`/admin/projects?${generalQs.toString()}`),
          adminFetch(`/admin/projects?${wdoQs.toString()}`),
        ]);
        const [generalData, wdoData] = await Promise.all([generalRes.json(), wdoRes.json()]);
        setProjects([...(generalData.projects || []), ...(wdoData.projects || [])]);
      } else {
        const [allRes, wdoRes] = await Promise.all([
          adminFetch(`/admin/projects?${qs.toString()}`),
          adminFetch(`/admin/projects?${wdoQs.toString()}`),
        ]);
        const [allData, wdoData] = await Promise.all([allRes.json(), wdoRes.json()]);
        setProjects(mergeProjectsUnique(allData.projects || [], wdoData.projects || []));
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [filterStatus, filterType]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    adminFetch('/admin/projects/types').then(r => r.json()).then(d => setTypesRegistry(d.types)).catch(() => {});
  }, []);

  const regularProjects = projects.filter(p => p.project_type !== WDO_TYPE && (!filterType || p.project_type === filterType));
  const wdoProjects = projects.filter(p => p.project_type === WDO_TYPE);
  const selected = projects.find(p => p.id === selectedId);

  return (
    <div style={{ padding: '16px 4px', color: D.text, fontFamily: "'DM Sans', sans-serif" }}>
      <header style={{
        marginBottom: 16,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
      }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>
            <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>Projects</span>
            <span className="hidden md:inline">Projects</span>
          </h1>
        </div>
        <button
          type="button"
          onClick={() => setCreateMode('general')}
          style={{
            padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700,
            background: D.accent, color: '#fff', border: 'none', cursor: 'pointer',
            whiteSpace: 'nowrap', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em',
            fontFamily: "'DM Sans', sans-serif",
          }}
        >+ New Project</button>
      </header>

      {/* Filters */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12,
        background: D.card, padding: '10px 12px', borderRadius: 10, border: `1px solid ${D.border}`,
      }}>
        <FilterPill label="All statuses" active={!filterStatus} onClick={() => setFilterStatus('')} />
        {['draft', 'sent', 'closed'].map(s => (
          <FilterPill
            key={s}
            label={STATUS_STYLES[s].label}
            active={filterStatus === s}
            onClick={() => setFilterStatus(filterStatus === s ? '' : s)}
          />
        ))}
        <div style={{ width: 12 }} />
        <FilterPill label="All types" active={!filterType} onClick={() => setFilterType('')} />
        {Object.entries(GENERAL_TYPE_LABELS).map(([key, label]) => (
          <FilterPill
            key={key}
            label={label}
            active={filterType === key}
            onClick={() => setFilterType(filterType === key ? '' : key)}
          />
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1.4fr' : '1fr', gap: 16 }}>
        {/* List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading ? (
            <div style={{ padding: 24, color: D.muted }}>Loading…</div>
          ) : regularProjects.length === 0 ? (
            <div style={{
              padding: 24, background: D.card, borderRadius: 10,
              border: `1px dashed ${D.border}`, color: D.muted, textAlign: 'center',
            }}>
              No projects match these filters.
            </div>
          ) : (
            regularProjects.map(p => (
              <ProjectRow
                key={p.id}
                project={p}
                active={selectedId === p.id}
                onSelect={() => setSelectedId(p.id)}
              />
            ))
          )}

          <WdoReportsSection
            projects={wdoProjects}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreate={() => setCreateMode('wdo')}
          />
        </div>

        {/* Detail */}
        {selected && (
          <ProjectDetail
            projectId={selected.id}
            typesRegistry={typesRegistry}
            onClose={() => setSelectedId(null)}
            onChanged={loadProjects}
          />
        )}
      </div>

      {createMode && (
        <CreateProjectModal
          theme="light"
          allowAiDraft
          defaultProjectType={createMode === 'wdo' ? WDO_TYPE : ''}
          allowedProjectTypes={createMode === 'wdo' ? [WDO_TYPE] : GENERAL_PROJECT_TYPES}
          onClose={() => setCreateMode(null)}
          onCreated={(p) => {
            setCreateMode(null);
            loadProjects();
            if (p?.id) setSelectedId(p.id);
          }}
        />
      )}
    </div>
  );
}

function WdoReportsSection({ projects, selectedId, onSelect, onCreate }) {
  const urgentCount = projects.filter(p => {
    if (p.status === 'sent' || p.status === 'closed') return false;
    const created = p.created_at ? new Date(p.created_at).getTime() : 0;
    return created && Date.now() - created > 24 * 60 * 60 * 1000;
  }).length;

  return (
    <section style={{
      marginTop: 18,
      paddingTop: 16,
      borderTop: `1px solid ${D.border}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: D.muted, textTransform: 'uppercase', letterSpacing: 1 }}>
            WDO Inspection Reports
          </div>
          <div style={{ fontSize: 13, color: D.text, marginTop: 3 }}>
            Real-estate reports, realtor sharing, and closing-sensitive documentation.
          </div>
          {urgentCount > 0 && (
            <div style={{ fontSize: 11, color: D.amber, marginTop: 4, fontWeight: 700 }}>
              {urgentCount} draft{urgentCount === 1 ? '' : 's'} older than 24h
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onCreate}
          style={{
            ...btnSecondary,
            padding: '7px 10px',
            fontSize: 11,
            fontWeight: 800,
            whiteSpace: 'nowrap',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          + New WDO
        </button>
      </div>

      {projects.length === 0 ? (
        <div style={{
          padding: 18,
          background: D.card,
          borderRadius: 10,
          border: `1px dashed ${D.border}`,
          color: D.muted,
          fontSize: 12,
          textAlign: 'center',
        }}>
          No WDO reports match these filters.
        </div>
      ) : (
        projects.map(p => (
          <ProjectRow
            key={p.id}
            project={p}
            active={selectedId === p.id}
            onSelect={() => onSelect(p.id)}
            compactType="WDO"
          />
        ))
      )}
    </section>
  );
}

function FilterPill({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
        background: active ? D.accent : D.pill,
        color: active ? '#fff' : D.text,
        border: `1px solid ${active ? D.accent : D.inputBorder}`,
        cursor: 'pointer',
      }}
    >{label}</button>
  );
}

function ProjectRow({ project, active, onSelect, compactType }) {
  const status = STATUS_STYLES[project.status] || STATUS_STYLES.draft;
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: 'left', width: '100%', cursor: 'pointer',
        background: D.card, border: `1px solid ${active ? D.accent : D.border}`,
        borderRadius: 10, padding: '12px 14px',
        display: 'flex', gap: 12, alignItems: 'flex-start',
      }}
    >
      <div style={{
        flexShrink: 0, width: 48, height: 48, borderRadius: 8,
        background: D.pill, display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: MONO, fontSize: 11, fontWeight: 700, color: D.heading,
      }}>
        {compactType || TYPE_LABELS[project.project_type] || 'Proj'}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: D.heading, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project.customer_name || 'Customer'}
          </div>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
            background: status.bg, color: status.fg, textTransform: 'uppercase', letterSpacing: 0.5,
            whiteSpace: 'nowrap',
          }}>{status.label}</span>
        </div>
        <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
          {project.title || TYPE_LABELS[project.project_type] || project.project_type}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 6, fontSize: 11, color: D.muted }}>
          <span>{fmtDate(project.created_at)}</span>
          <span>·</span>
          <span>{project.tech_name || 'Tech'}</span>
          {project.photo_count > 0 && (<><span>·</span><span>{project.photo_count} 📸</span></>)}
        </div>
      </div>
    </button>
  );
}

function ProjectDetail({ projectId, typesRegistry, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editFindings, setEditFindings] = useState({});
  const [editRecs, setEditRecs] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [sentLink, setSentLink] = useState('');
  const [aiWriting, setAiWriting] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await adminFetch(`/admin/projects/${projectId}`);
      const d = await r.json();
      setData(d);
      setEditFindings(d.project.findings || {});
      setEditRecs(d.project.recommendations || '');
      setEditTitle(d.project.title || '');
      setDirty(false);
      if (d.project.report_token) {
        setSentLink(`${window.location.origin}/report/project/${d.project.report_token}`);
      } else {
        setSentLink('');
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [projectId]);

  const project = data?.project;
  const typeCfg = project && typesRegistry ? typesRegistry[project.project_type] : null;

  async function saveEdits() {
    setSaving(true);
    try {
      await adminFetch(`/admin/projects/${projectId}`, {
        method: 'PUT',
        body: { title: editTitle || null, findings: editFindings, recommendations: editRecs || null },
      });
      setDirty(false);
      await load();
      onChanged?.();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  async function handleSend() {
    if (!confirm('Send report to customer? This generates a public link and marks the project as Sent.')) return;
    setSaving(true);
    try {
      // Persist any dirty edits (including an AI-drafted Recommendations block)
      // before we flip the project to Sent — otherwise the customer sees the
      // pre-edit version at the public link.
      if (dirty) {
        await adminFetch(`/admin/projects/${projectId}`, {
          method: 'PUT',
          body: { title: editTitle || null, findings: editFindings, recommendations: editRecs || null },
        });
        setDirty(false);
      }
      const r = await adminFetch(`/admin/projects/${projectId}/send`, { method: 'POST' });
      const d = await r.json();
      if (d.report_url) setSentLink(`${window.location.origin}${d.report_url}`);
      await load();
      onChanged?.();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  async function handleAiWrite() {
    // Drafts into the Recommendations field. Replaces existing content so the
    // admin can tell what came from AI vs. what they kept by-hand; if the
    // admin liked prior text, Cmd-Z restores it before save.
    if (editRecs && editRecs.trim() && !confirm('Replace the current Recommendations text with an AI-drafted version?\n\nThe tech\'s original notes will still be used as context for the AI.')) return;
    setAiWriting(true);
    try {
      const r = await adminFetch(`/admin/projects/${projectId}/ai-write`, {
        method: 'POST',
        body: { findings: editFindings, recommendations: editRecs },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'AI draft failed');
      if (d.report) {
        const aiText = d.report.trim();
        setEditRecs(aiText);
        // Autosave the AI draft so it can't be lost by hitting Send before
        // the admin manually saves. Other pending edits (title/findings)
        // are included in the same PUT.
        try {
          await adminFetch(`/admin/projects/${projectId}`, {
            method: 'PUT',
            body: { title: editTitle || null, findings: editFindings, recommendations: aiText },
          });
          setDirty(false);
          await load();
        } catch {
          // Autosave failed — leave it marked dirty so manual Save still works.
          setDirty(true);
        }
      }
    } catch (e) {
      alert(`AI draft failed: ${e.message}`);
    } finally {
      setAiWriting(false);
    }
  }

  async function handleClose() {
    if (!confirm('Close this project? It stays accessible but is filtered out of Sent view.')) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/projects/${projectId}/close`, { method: 'POST' });
      await load();
      onChanged?.();
    } catch { /* ignore */ }
    finally { setSaving(false); }
  }

  async function handlePhotoDelete(photoId) {
    if (!confirm('Remove this photo?')) return;
    try {
      await adminFetch(`/admin/projects/${projectId}/photos/${photoId}`, { method: 'DELETE' });
      await load();
    } catch { /* ignore */ }
  }

  async function handlePhotoUpload(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setSaving(true);
    for (const f of files) {
      const fd = new FormData();
      fd.append('photo', f);
      try {
        await adminFetch(`/admin/projects/${projectId}/photos`, { method: 'POST', body: fd, headers: {} });
      } catch { /* ignore */ }
    }
    await load();
    setSaving(false);
  }

  if (loading || !project) {
    return (
      <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: 24, color: D.muted }}>
        Loading project…
      </div>
    );
  }

  const status = STATUS_STYLES[project.status] || STATUS_STYLES.draft;

  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '14px 16px', borderBottom: `1px solid ${D.border}`,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, fontWeight: 700 }}>
            {typeCfg?.label || project.project_type} · {project.customer_name}
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: D.heading, marginTop: 4 }}>
            {project.title || typeCfg?.label || 'Project'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
              background: status.bg, color: status.fg, textTransform: 'uppercase', letterSpacing: 0.5,
            }}>{status.label}</span>
            <span style={{ fontSize: 11, color: D.muted }}>Created {fmtDate(project.created_at)} by {project.tech_name || '—'}</span>
            {project.sent_at && (
              <span style={{ fontSize: 11, color: D.muted }}>· Sent {fmtDate(project.sent_at)}</span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'transparent', border: 'none', color: D.muted,
            fontSize: 22, cursor: 'pointer', padding: '0 8px',
          }}
          aria-label="Close"
        >×</button>
      </div>

      {/* Body */}
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
        {sentLink && (
          <div style={{
            padding: '10px 12px', background: '#ECFDF5', border: `1px solid #A7F3D0`,
            borderRadius: 8, fontSize: 12, color: D.heading,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Customer-facing report</div>
            <div style={{ fontFamily: MONO, fontSize: 11, wordBreak: 'break-all' }}>
              <a href={sentLink} target="_blank" rel="noreferrer" style={{ color: '#065F46' }}>{sentLink}</a>
            </div>
          </div>
        )}

        {project.project_type === WDO_TYPE && (
          <div style={{
            padding: '10px 12px',
            background: D.pill,
            border: `1px solid ${D.border}`,
            borderRadius: 8,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: D.heading }}>FDACS-13645 WDO form</div>
              <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>Use this as the official inspection template and review copy.</div>
            </div>
            <a
              href="/forms/fdacs-13645-wdo-inspection-report.pdf"
              target="_blank"
              rel="noreferrer"
              style={{
                flexShrink: 0,
                padding: '7px 10px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 800,
                color: D.heading,
                textDecoration: 'none',
                background: D.card,
                border: `1px solid ${D.inputBorder}`,
              }}
            >
              Open PDF
            </a>
          </div>
        )}

        {/* Title */}
        <div>
          <Label>Report title</Label>
          <input
            type="text"
            value={editTitle}
            onChange={(e) => { setEditTitle(e.target.value); setDirty(true); }}
            placeholder={typeCfg?.label || 'Project'}
            style={inputStyle}
          />
        </div>

        {/* Type-specific findings */}
        {typeCfg?.findingsFields?.map(field => (
          <div key={field.key}>
            <Label>{field.label}</Label>
            {field.type === 'select' ? (
              <select
                value={editFindings[field.key] || ''}
                onChange={(e) => { setEditFindings(f => ({ ...f, [field.key]: e.target.value })); setDirty(true); }}
                style={inputStyle}
              >
                <option value="">Select…</option>
                {field.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            ) : field.type === 'textarea' ? (
              <textarea
                value={editFindings[field.key] || ''}
                onChange={(e) => { setEditFindings(f => ({ ...f, [field.key]: e.target.value })); setDirty(true); }}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', minHeight: 72 }}
              />
            ) : (
              <input
                type="text"
                value={editFindings[field.key] || ''}
                onChange={(e) => { setEditFindings(f => ({ ...f, [field.key]: e.target.value })); setDirty(true); }}
                style={inputStyle}
              />
            )}
          </div>
        ))}

        {/* Recommendations */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <Label style={{ margin: 0 }}>Recommendations / notes</Label>
            <button
              type="button"
              onClick={handleAiWrite}
              disabled={aiWriting || saving}
              title="Claude drafts What We Inspected / Found / Recommend from the findings and tech notes."
              style={{
                padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                background: aiWriting ? D.muted : D.card, color: D.heading,
                border: `1px solid ${D.inputBorder}`,
                cursor: (aiWriting || saving) ? 'default' : 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              <span aria-hidden="true">✨</span>
              {aiWriting ? 'Drafting…' : 'Write with AI'}
            </button>
          </div>
          <textarea
            value={editRecs}
            onChange={(e) => { setEditRecs(e.target.value); setDirty(true); }}
            rows={8}
            placeholder={`Write freely, or tap "Write with AI" to draft the three customer-facing sections from the findings above.`}
            style={{ ...inputStyle, resize: 'vertical', minHeight: 160, fontFamily: "'DM Sans', sans-serif" }}
          />
        </div>

        {/* Photos */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Label style={{ margin: 0 }}>Photos ({data.photos?.length || 0})</Label>
            <label style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700,
              background: D.accent, color: '#fff', cursor: 'pointer',
            }}>
              + Upload
              <input type="file" accept="image/*" multiple onChange={handlePhotoUpload} style={{ display: 'none' }} />
            </label>
          </div>
          {data.photos?.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
              {data.photos.map(ph => <PhotoThumb key={ph.id} photo={ph} projectId={projectId} onDelete={() => handlePhotoDelete(ph.id)} />)}
            </div>
          ) : (
            <div style={{ padding: '20px 0', fontSize: 12, color: D.muted, textAlign: 'center' }}>
              No photos yet.
            </div>
          )}
        </div>
      </div>

      {/* Footer actions */}
      <div style={{
        padding: '12px 16px', borderTop: `1px solid ${D.border}`,
        display: 'flex', gap: 10, justifyContent: 'flex-end', alignItems: 'center',
      }}>
        {project.status !== 'closed' && (
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            style={{ ...btnSecondary, opacity: saving ? 0.5 : 1 }}
          >Close project</button>
        )}
        <button
          type="button"
          onClick={saveEdits}
          disabled={saving || !dirty}
          style={{ ...btnSecondary, opacity: (saving || !dirty) ? 0.4 : 1 }}
        >{saving ? 'Saving…' : 'Save changes'}</button>
        {project.status !== 'sent' && project.status !== 'closed' && (
          <button
            type="button"
            onClick={handleSend}
            disabled={saving}
            style={{ ...btnPrimary, opacity: saving ? 0.5 : 1 }}
          >Send report</button>
        )}
      </div>
    </div>
  );
}

function PhotoThumb({ photo, projectId, onDelete }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    adminFetch(`/admin/projects/${projectId}/photos/${photo.id}/url`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setUrl(d.url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [projectId, photo.id]);

  return (
    <div style={{
      position: 'relative', background: D.pill, borderRadius: 8,
      border: `1px solid ${D.border}`, overflow: 'hidden', aspectRatio: '1/1',
    }}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" style={{ display: 'block', width: '100%', height: '100%' }}>
          <img src={url} alt={photo.caption || photo.category || 'Photo'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </a>
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: D.muted }}>
          Loading…
        </div>
      )}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0, padding: '4px 6px',
        background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: 10, fontWeight: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {(photo.category || '').replace(/_/g, ' ')}
        </span>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); onDelete(); }}
          style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 13, padding: 0, lineHeight: 1 }}
          aria-label="Remove photo"
        >×</button>
      </div>
    </div>
  );
}

function Label({ children, style }) {
  return (
    <div style={{
      fontSize: 11, fontWeight: 700, color: D.muted,
      textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6,
      ...(style || {}),
    }}>{children}</div>
  );
}

const inputStyle = {
  width: '100%',
  background: D.card, color: D.text,
  border: `1px solid ${D.inputBorder}`,
  borderRadius: 8, padding: '9px 12px',
  fontSize: 13, boxSizing: 'border-box',
  fontFamily: "'DM Sans', sans-serif",
};

const btnPrimary = {
  padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 700,
  background: D.accent, color: '#fff', border: 'none', cursor: 'pointer',
};
const btnSecondary = {
  padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
  background: D.card, color: D.text, border: `1px solid ${D.inputBorder}`, cursor: 'pointer',
};
