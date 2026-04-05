import { useState, useEffect, useCallback, useMemo } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', blue: '#2563eb', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

// ── Shared styles ──
const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" });
const sBtnOutline = { ...sBtn('transparent', D.muted), border: `1px solid ${D.border}` };
const sInput = { width: '100%', padding: '10px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, fontFamily: "'DM Sans', sans-serif", outline: 'none', boxSizing: 'border-box' };
const sLabel = { fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: 600, marginBottom: 4, display: 'block' };
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600, display: 'inline-block' });

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════
export default function GBPManagement() {
  const [locations, setLocations] = useState([]);
  const [selectedLoc, setSelectedLoc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState('overview');
  const [updates, setUpdates] = useState([]);
  const [updatesFilter, setUpdatesFilter] = useState('pending');
  const [syncing, setSyncing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [toast, setToast] = useState('');

  // Load locations
  const loadLocations = useCallback(async () => {
    try {
      const d = await adminFetch('/admin/gbp/locations');
      setLocations(d.locations || []);
      if (d.locations?.length > 0 && !selectedLoc) setSelectedLoc(d.locations[0]);
    } catch { /* fallback to Places API data */
      try {
        const d = await adminFetch('/admin/reviews/gbp-locations');
        const locs = (d.locations || []).map(l => ({ ...l, gbp: null, hasCredentials: false, pendingUpdates: 0 }));
        setLocations(locs);
        if (locs.length > 0) setSelectedLoc(locs[0]);
      } catch { /* ignore */ }
    }
    setLoading(false);
  }, []);

  const loadUpdates = useCallback(async (status) => {
    try {
      const d = await adminFetch(`/admin/gbp/updates?status=${status || updatesFilter}&limit=100`);
      setUpdates(d.updates || []);
    } catch { setUpdates([]); }
  }, [updatesFilter]);

  useEffect(() => { loadLocations(); }, [loadLocations]);
  useEffect(() => { loadUpdates(updatesFilter); }, [updatesFilter]);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3500); };

  const handleSync = async (locId) => {
    setSyncing(true);
    try {
      const d = await adminFetch(`/admin/gbp/locations/${locId}/sync`, { method: 'POST' });
      showToast(`Synced ${locId}: ${d.changesDetected} change(s) detected`);
      await loadLocations();
      await loadUpdates();
    } catch (e) { showToast(`Sync failed: ${e.message}`); }
    setSyncing(false);
  };

  const handleSyncAll = async () => {
    setSyncing(true);
    for (const loc of locations) {
      try { await adminFetch(`/admin/gbp/locations/${loc.id}/sync`, { method: 'POST' }); } catch { /* skip */ }
    }
    showToast('All locations synced');
    await loadLocations();
    await loadUpdates();
    setSyncing(false);
  };

  const handlePush = async (locId) => {
    setPushing(true);
    try {
      const d = await adminFetch(`/admin/gbp/locations/${locId}/push`, { method: 'POST' });
      showToast(`Pushed to Google: ${d.updatedFields?.join(', ')}`);
    } catch (e) { showToast(`Push failed: ${e.message}`); }
    setPushing(false);
  };

  const handleApprove = async (updateId) => {
    try {
      await adminFetch(`/admin/gbp/updates/${updateId}/approve`, { method: 'POST' });
      showToast('Update approved');
      await loadUpdates();
      await loadLocations();
    } catch (e) { showToast(`Approve failed: ${e.message}`); }
  };

  const handleReject = async (updateId) => {
    try {
      await adminFetch(`/admin/gbp/updates/${updateId}/reject`, { method: 'POST' });
      showToast('Update rejected');
      await loadUpdates();
    } catch (e) { showToast(`Reject failed: ${e.message}`); }
  };

  const handleBulkReject = async (ids) => {
    try {
      await adminFetch('/admin/gbp/updates/bulk-reject', { method: 'POST', body: JSON.stringify({ ids }) });
      showToast(`${ids.length} update(s) rejected`);
      await loadUpdates();
    } catch (e) { showToast(`Bulk reject failed: ${e.message}`); }
  };

  const loc = selectedLoc;
  const gbp = loc?.gbp;

  const subTabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'info', label: 'Business Info' },
    { key: 'hours', label: 'Hours' },
    { key: 'services', label: 'Services' },
    { key: 'photos', label: 'Photos' },
    { key: 'updates', label: 'Update Queue', badge: locations.reduce((s, l) => s + (l.pendingUpdates || 0), 0) },
    { key: 'history', label: 'Change History' },
    { key: 'bulk', label: 'Bulk Edit' },
    { key: 'notifications', label: 'Alerts' },
  ];

  if (loading) return <div style={{ color: D.muted, padding: 60, textAlign: 'center' }}>Loading GBP data...</div>;

  return (
    <div>
      {/* Location Selector */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {locations.map(l => (
          <button key={l.id} onClick={() => { setSelectedLoc(l); setSubTab('overview'); }} style={{
            padding: '12px 18px', borderRadius: 10, border: `1px solid ${selectedLoc?.id === l.id ? D.teal : D.border}`,
            background: selectedLoc?.id === l.id ? `${D.teal}15` : D.card, cursor: 'pointer', minWidth: 170, textAlign: 'left',
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: selectedLoc?.id === l.id ? D.teal : D.white }}>{l.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
              {l.rating && <span style={{ fontSize: 13, fontWeight: 700, color: D.amber, fontFamily: "'JetBrains Mono', monospace" }}>{l.rating}</span>}
              <span style={{ fontSize: 11, color: D.muted }}>({l.totalReviews || 0})</span>
              {l.pendingUpdates > 0 && <span style={sBadge(`${D.amber}22`, D.amber)}>{l.pendingUpdates} pending</span>}
            </div>
            <div style={{ fontSize: 10, marginTop: 4, color: l.hasCredentials ? D.green : D.muted }}>
              {l.hasCredentials ? '● API Connected' : '○ Places API only'}
            </div>
          </button>
        ))}
        <button onClick={handleSyncAll} disabled={syncing} style={{ ...sBtn(D.teal, D.white), opacity: syncing ? 0.5 : 1 }}>
          {syncing ? 'Syncing...' : 'Sync All'}
        </button>
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, flexWrap: 'wrap' }}>
        {subTabs.map(t => (
          <button key={t.key} onClick={() => setSubTab(t.key)} style={{
            padding: '10px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500,
            background: subTab === t.key ? D.teal : 'transparent', color: subTab === t.key ? D.white : D.muted,
            transition: 'all 0.15s', fontFamily: "'DM Sans', sans-serif", display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {t.label}
            {t.badge > 0 && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 10, background: subTab === t.key ? 'rgba(255,255,255,0.2)' : `${D.amber}33`, color: subTab === t.key ? D.white : D.amber, fontWeight: 700 }}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {!loc ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No locations available</div>
      ) : (
        <>
          {subTab === 'overview' && <OverviewTab loc={loc} gbp={gbp} onSync={() => handleSync(loc.id)} onPush={() => handlePush(loc.id)} syncing={syncing} pushing={pushing} />}
          {subTab === 'info' && <BusinessInfoTab loc={loc} gbp={gbp} onSave={loadLocations} showToast={showToast} />}
          {subTab === 'hours' && <HoursTab loc={loc} gbp={gbp} onSave={loadLocations} showToast={showToast} />}
          {subTab === 'services' && <ServicesTab loc={loc} gbp={gbp} onSave={loadLocations} showToast={showToast} />}
          {subTab === 'photos' && <PhotosTab loc={loc} gbp={gbp} />}
          {subTab === 'updates' && <UpdateQueueTab updates={updates.filter(u => u.status === 'pending')} locations={locations} onApprove={handleApprove} onReject={handleReject} onBulkReject={handleBulkReject} />}
          {subTab === 'history' && <ChangeHistoryTab updates={updates} locations={locations} filter={updatesFilter} setFilter={setUpdatesFilter} loadUpdates={loadUpdates} />}
          {subTab === 'bulk' && <BulkEditTab locations={locations} onSave={loadLocations} showToast={showToast} />}
          {subTab === 'notifications' && <NotificationsTab showToast={showToast} />}
        </>
      )}

      {/* Toast */}
      <div style={{
        position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8,
        padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)',
        zIndex: 300, fontSize: 12, fontWeight: 500, transform: toast ? 'translateY(0)' : 'translateY(80px)',
        opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none',
      }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ══════════════════════════════════════════════════════════════
function OverviewTab({ loc, gbp, onSync, onPush, syncing, pushing }) {
  const info = gbp || {};
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Left — Profile Summary */}
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Profile Summary</div>
        {[
          { label: 'Business Name', value: info.business_name || loc.name },
          { label: 'Address', value: info.address || loc.address },
          { label: 'Phone', value: info.phone || loc.phone },
          { label: 'Website', value: info.website_url, link: true },
          { label: 'Primary Category', value: info.primary_category || 'pest_control' },
          { label: 'Store Code', value: info.store_code || '—' },
          { label: 'Place ID', value: loc.googlePlaceId },
          { label: 'Last Synced', value: info.last_synced_at ? new Date(info.last_synced_at).toLocaleString() : 'Never' },
        ].map((f, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '8px 0', borderBottom: `1px solid ${D.border}33` }}>
            <span style={{ fontSize: 12, color: D.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, minWidth: 120 }}>{f.label}</span>
            {f.link ? (
              <a href={f.value} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: D.teal, textDecoration: 'none', textAlign: 'right', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.value || '—'}</a>
            ) : (
              <span style={{ fontSize: 13, color: D.white, textAlign: 'right', maxWidth: 280 }}>{f.value || '—'}</span>
            )}
          </div>
        ))}
      </div>

      {/* Right — Rating + Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...sCard, textAlign: 'center' }}>
          <div style={{ fontSize: 48, fontWeight: 800, color: D.amber, fontFamily: "'JetBrains Mono', monospace" }}>{loc.rating || '—'}</div>
          <div style={{ fontSize: 14, color: D.muted, marginTop: 4 }}>{loc.totalReviews || 0} reviews on Google</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'center', flexWrap: 'wrap' }}>
            {loc.mapsUrl && <a href={loc.mapsUrl} target="_blank" rel="noopener noreferrer" style={{ ...sBtn(D.teal, D.white), textDecoration: 'none' }}>View on Maps</a>}
            {loc.googleReviewUrl && <a href={loc.googleReviewUrl} target="_blank" rel="noopener noreferrer" style={{ ...sBtnOutline, textDecoration: 'none' }}>Review Link</a>}
          </div>
        </div>

        <div style={sCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 12 }}>Actions</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={onSync} disabled={syncing} style={{ ...sBtn(D.teal, D.white), width: '100%', opacity: syncing ? 0.5 : 1 }}>
              {syncing ? 'Syncing from Google...' : 'Sync from Google'}
            </button>
            <button onClick={onPush} disabled={pushing || !loc.hasCredentials} style={{ ...sBtn(D.green, D.white), width: '100%', opacity: pushing || !loc.hasCredentials ? 0.5 : 1 }}>
              {pushing ? 'Pushing...' : 'Push to Google'}
            </button>
            {!loc.hasCredentials && <div style={{ fontSize: 11, color: D.amber, textAlign: 'center' }}>OAuth not configured — push disabled</div>}
            <a href={`https://business.google.com/dashboard/l/${loc.googlePlaceId}`} target="_blank" rel="noopener noreferrer" style={{ ...sBtnOutline, textDecoration: 'none', textAlign: 'center' }}>Open Google Business</a>
            <a href={`https://business.google.com/posts/l/${loc.googlePlaceId}`} target="_blank" rel="noopener noreferrer" style={{ ...sBtnOutline, textDecoration: 'none', textAlign: 'center' }}>Create Google Post</a>
          </div>
        </div>

        {/* SAB indicator */}
        {info.hide_address && (
          <div style={{ ...sCard, borderColor: D.amber }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.amber, marginBottom: 4 }}>Service-Area Business</div>
            <div style={{ fontSize: 12, color: D.muted }}>Address is hidden on Google. This location serves customers at their premises.</div>
            {info.service_areas && (() => {
              const areas = typeof info.service_areas === 'string' ? JSON.parse(info.service_areas) : info.service_areas;
              return areas.length > 0 && <div style={{ fontSize: 12, color: D.text, marginTop: 8 }}>Areas: {areas.map(a => a.name || a).join(', ')}</div>;
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BUSINESS INFO TAB — editable fields
// ══════════════════════════════════════════════════════════════
function BusinessInfoTab({ loc, gbp, onSave, showToast }) {
  const [form, setForm] = useState({
    business_name: '', description: '', phone: '', website_url: '',
    primary_category: '', store_code: '', hide_address: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (gbp) {
      setForm({
        business_name: gbp.business_name || loc.name || '',
        description: gbp.description || '',
        phone: gbp.phone || loc.phone || '',
        website_url: gbp.website_url || '',
        primary_category: gbp.primary_category || '',
        store_code: gbp.store_code || '',
        hide_address: gbp.hide_address || false,
      });
    }
  }, [gbp, loc]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/gbp/locations/${loc.id}`, { method: 'PUT', body: JSON.stringify(form) });
      showToast('Profile updated');
      onSave();
    } catch (e) { showToast(`Save failed: ${e.message}`); }
    setSaving(false);
  };

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Edit Business Information</div>
        <FieldGroup>
          <Field label="Business Name">
            <input value={form.business_name} onChange={e => setForm(f => ({ ...f, business_name: e.target.value }))} style={sInput} />
          </Field>
          <Field label="Phone">
            <input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={sInput} />
          </Field>
        </FieldGroup>
        <Field label="Website URL">
          <input value={form.website_url} onChange={e => setForm(f => ({ ...f, website_url: e.target.value }))} style={sInput} />
        </Field>
        <Field label="Primary Category">
          <input value={form.primary_category} onChange={e => setForm(f => ({ ...f, primary_category: e.target.value }))} style={sInput} placeholder="e.g. pest_control_service" />
        </Field>
        <Field label="Store Code">
          <input value={form.store_code} onChange={e => setForm(f => ({ ...f, store_code: e.target.value }))} style={sInput} placeholder="Optional identifier" />
        </Field>
        <Field label="Description">
          <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={4} style={{ ...sInput, resize: 'vertical' }} placeholder="Business description shown on Google..." />
        </Field>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: D.text, marginBottom: 16 }}>
          <input type="checkbox" checked={form.hide_address} onChange={e => setForm(f => ({ ...f, hide_address: e.target.checked }))} style={{ accentColor: D.teal }} />
          Service-Area Business (hide address)
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={handleSave} disabled={saving} style={{ ...sBtn(D.teal, D.white), opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Save Changes'}</button>
          <button onClick={() => showToast('Push to Google to apply changes')} style={sBtnOutline}>Push to Google</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// HOURS TAB
// ══════════════════════════════════════════════════════════════
function HoursTab({ loc, gbp, onSave, showToast }) {
  const [hours, setHours] = useState({});
  const [specialHours, setSpecialHours] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (gbp?.regular_hours) {
      const h = typeof gbp.regular_hours === 'string' ? JSON.parse(gbp.regular_hours) : gbp.regular_hours;
      setHours(h);
    }
    if (gbp?.special_hours) {
      const sh = typeof gbp.special_hours === 'string' ? JSON.parse(gbp.special_hours) : gbp.special_hours;
      setSpecialHours(sh);
    }
  }, [gbp]);

  const updateDay = (day, field, value) => {
    setHours(prev => ({ ...prev, [day]: { ...(prev[day] || {}), [field]: value } }));
  };

  const addSpecialHour = () => {
    setSpecialHours(prev => [...prev, { date: '', open: '08:00', close: '17:00', closed: false }]);
  };

  const updateSpecial = (idx, field, value) => {
    setSpecialHours(prev => prev.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  };

  const removeSpecial = (idx) => {
    setSpecialHours(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/gbp/locations/${loc.id}/hours`, { method: 'PUT', body: JSON.stringify({ hours }) });
      if (specialHours.length > 0) {
        await adminFetch(`/admin/gbp/locations/${loc.id}/special-hours`, { method: 'PUT', body: JSON.stringify({ specialHours }) });
      }
      showToast('Hours updated');
      onSave();
    } catch (e) { showToast(`Save failed: ${e.message}`); }
    setSaving(false);
  };

  const isToday = (day) => DAYS[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1] === day;

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Regular Hours</div>
        {DAYS.map(day => {
          const h = hours[day] || {};
          const today = isToday(day);
          return (
            <div key={day} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderRadius: 8, marginBottom: 4,
              background: today ? `${D.teal}10` : 'transparent', border: today ? `1px solid ${D.teal}33` : '1px solid transparent',
            }}>
              <span style={{ fontSize: 13, fontWeight: today ? 600 : 400, color: today ? D.teal : D.white, width: 100, textTransform: 'capitalize' }}>{day}</span>
              <input type="time" value={h.open || '08:00'} onChange={e => updateDay(day, 'open', e.target.value)} style={{ ...sInput, width: 120 }} />
              <span style={{ color: D.muted, fontSize: 12 }}>to</span>
              <input type="time" value={h.close || '17:00'} onChange={e => updateDay(day, 'close', e.target.value)} style={{ ...sInput, width: 120 }} />
            </div>
          );
        })}
      </div>

      <div style={sCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Special Hours</div>
          <button onClick={addSpecialHour} style={sBtn(D.teal, D.white)}>+ Add</button>
        </div>
        {specialHours.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>No special hours set. Add holidays, seasonal hours, etc.</div>
        ) : specialHours.map((sh, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, padding: 10, background: D.input, borderRadius: 8 }}>
            <input type="date" value={sh.date} onChange={e => updateSpecial(i, 'date', e.target.value)} style={{ ...sInput, width: 150 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: D.muted, cursor: 'pointer' }}>
              <input type="checkbox" checked={sh.closed} onChange={e => updateSpecial(i, 'closed', e.target.checked)} style={{ accentColor: D.red }} />
              Closed
            </label>
            {!sh.closed && (
              <>
                <input type="time" value={sh.open} onChange={e => updateSpecial(i, 'open', e.target.value)} style={{ ...sInput, width: 110 }} />
                <span style={{ color: D.muted, fontSize: 12 }}>to</span>
                <input type="time" value={sh.close} onChange={e => updateSpecial(i, 'close', e.target.value)} style={{ ...sInput, width: 110 }} />
              </>
            )}
            <button onClick={() => removeSpecial(i)} style={{ background: 'none', border: 'none', color: D.red, cursor: 'pointer', fontSize: 16 }}>×</button>
          </div>
        ))}
      </div>

      <button onClick={handleSave} disabled={saving} style={{ ...sBtn(D.teal, D.white), opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Save Hours'}</button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SERVICES TAB
// ══════════════════════════════════════════════════════════════
function ServicesTab({ loc, gbp, onSave, showToast }) {
  const [services, setServices] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [newService, setNewService] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadingSugg, setLoadingSugg] = useState(false);

  useEffect(() => {
    if (gbp?.services) {
      const s = typeof gbp.services === 'string' ? JSON.parse(gbp.services) : gbp.services;
      setServices(s);
    }
  }, [gbp]);

  const loadSuggestions = async () => {
    setLoadingSugg(true);
    try {
      const d = await adminFetch(`/admin/gbp/services/suggestions?category=${encodeURIComponent(gbp?.primary_category || 'pest_control')}`);
      setSuggestions(d.services || []);
    } catch { setSuggestions([]); }
    setLoadingSugg(false);
  };

  useEffect(() => { loadSuggestions(); }, []);

  const addService = (name) => {
    if (!name.trim() || services.includes(name.trim())) return;
    setServices(prev => [...prev, name.trim()]);
    setNewService('');
  };

  const removeService = (idx) => { setServices(prev => prev.filter((_, i) => i !== idx)); };

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch(`/admin/gbp/locations/${loc.id}/services`, { method: 'PUT', body: JSON.stringify({ services }) });
      showToast('Services updated');
      onSave();
    } catch (e) { showToast(`Save failed: ${e.message}`); }
    setSaving(false);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
      {/* Current services */}
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Current Services ({services.length})</div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input value={newService} onChange={e => setNewService(e.target.value)} onKeyDown={e => e.key === 'Enter' && addService(newService)} placeholder="Add a service..." style={{ ...sInput, flex: 1 }} />
          <button onClick={() => addService(newService)} style={sBtn(D.teal, D.white)}>Add</button>
        </div>
        {services.length === 0 ? (
          <div style={{ color: D.muted, fontSize: 13, textAlign: 'center', padding: 20 }}>No services listed yet</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {services.map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: D.input, borderRadius: 8, fontSize: 13, color: D.text }}>
                {s}
                <button onClick={() => removeService(i)} style={{ background: 'none', border: 'none', color: D.red, cursor: 'pointer', fontSize: 14 }}>×</button>
              </div>
            ))}
          </div>
        )}
        <button onClick={handleSave} disabled={saving} style={{ ...sBtn(D.teal, D.white), marginTop: 16, opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Save Services'}</button>
      </div>

      {/* Suggested services */}
      <div style={sCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Google Suggestions</div>
          <button onClick={loadSuggestions} disabled={loadingSugg} style={sBtnOutline}>{loadingSugg ? 'Loading...' : 'Refresh'}</button>
        </div>
        <div style={{ fontSize: 12, color: D.muted, marginBottom: 12 }}>Click to add to your profile</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {suggestions.filter(s => !services.includes(s)).map((s, i) => (
            <button key={i} onClick={() => addService(s)} style={{
              padding: '6px 12px', borderRadius: 20, border: `1px solid ${D.border}`, background: 'transparent',
              color: D.muted, fontSize: 12, cursor: 'pointer', transition: 'all .15s',
            }}>{s}</button>
          ))}
          {suggestions.length === 0 && <div style={{ color: D.muted, fontSize: 13 }}>No suggestions available</div>}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PHOTOS TAB
// ══════════════════════════════════════════════════════════════
function PhotosTab({ loc, gbp }) {
  const photos = useMemo(() => {
    if (!gbp?.photos) return loc.photos || [];
    const p = typeof gbp.photos === 'string' ? JSON.parse(gbp.photos) : gbp.photos;
    return p.length > 0 ? p : loc.photos || [];
  }, [gbp, loc]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>{loc.name} Photos ({photos.length})</div>
        <a href={`https://business.google.com/photos/l/${loc.googlePlaceId}`} target="_blank" rel="noopener noreferrer" style={{ ...sBtnOutline, textDecoration: 'none' }}>Manage on Google</a>
      </div>
      {photos.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No photos found</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {photos.map((photo, i) => (
            <div key={i} style={{ borderRadius: 10, overflow: 'hidden', border: `1px solid ${D.border}`, background: D.card }}>
              <img src={photo.url || photo.name} alt={`${loc.name} photo ${i + 1}`} style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block' }} loading="lazy" onError={e => { e.target.style.display = 'none'; }} />
              <div style={{ padding: '8px 10px', fontSize: 11, color: D.muted }}>{photo.widthPx || photo.width}x{photo.heightPx || photo.height}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// UPDATE QUEUE TAB
// ══════════════════════════════════════════════════════════════
function UpdateQueueTab({ updates, locations, onApprove, onReject, onBulkReject }) {
  const [selectedIds, setSelectedIds] = useState(new Set());

  const toggleSel = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const locName = (id) => locations.find(l => l.id === id)?.name || id;
  const fieldLabel = (f) => f.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Pending Updates ({updates.length})</div>
        {selectedIds.size > 0 && (
          <button onClick={() => { onBulkReject([...selectedIds]); setSelectedIds(new Set()); }} style={sBtn(D.red, D.white)}>
            Reject Selected ({selectedIds.size})
          </button>
        )}
      </div>

      {updates.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>
          <div style={{ fontSize: 15 }}>No pending updates</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>All changes have been reviewed</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {updates.map(u => (
            <div key={u.id} style={{ ...sCard, marginBottom: 0, display: 'flex', alignItems: 'flex-start', gap: 12, borderColor: D.amber + '44' }}>
              <input type="checkbox" checked={selectedIds.has(u.id)} onChange={() => toggleSel(u.id)} style={{ accentColor: D.teal, marginTop: 4, cursor: 'pointer' }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: D.white }}>{fieldLabel(u.field_name)}</span>
                    <span style={sBadge(`${D.teal}22`, D.teal)}>{locName(u.location_id)}</span>
                    <span style={sBadge(`${D.purple}22`, D.purple)}>{u.source}</span>
                  </div>
                  <span style={{ fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>{new Date(u.detected_at).toLocaleString()}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
                  <div style={{ padding: 10, background: `${D.red}11`, borderRadius: 8, border: `1px solid ${D.red}22` }}>
                    <div style={{ fontSize: 10, color: D.red, fontWeight: 600, marginBottom: 4 }}>OLD VALUE</div>
                    <div style={{ color: D.muted, wordBreak: 'break-all', maxHeight: 60, overflow: 'hidden' }}>{u.old_value || '(empty)'}</div>
                  </div>
                  <div style={{ padding: 10, background: `${D.green}11`, borderRadius: 8, border: `1px solid ${D.green}22` }}>
                    <div style={{ fontSize: 10, color: D.green, fontWeight: 600, marginBottom: 4 }}>NEW VALUE</div>
                    <div style={{ color: D.text, wordBreak: 'break-all', maxHeight: 60, overflow: 'hidden' }}>{u.new_value || '(empty)'}</div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <button onClick={() => onApprove(u.id)} style={sBtn(D.green, D.white)}>Approve</button>
                <button onClick={() => onReject(u.id)} style={sBtn(D.red, D.white)}>Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CHANGE HISTORY TAB
// ══════════════════════════════════════════════════════════════
function ChangeHistoryTab({ updates, locations, filter, setFilter, loadUpdates }) {
  const locName = (id) => locations.find(l => l.id === id)?.name || id;
  const fieldLabel = (f) => f.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const statusColor = { pending: D.amber, approved: D.green, rejected: D.red };

  useEffect(() => { loadUpdates(filter); }, [filter]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white }}>Change History</div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['all', 'pending', 'approved', 'rejected'].map(f => (
            <button key={f} onClick={() => { setFilter(f === 'all' ? '' : f); }} style={{
              padding: '6px 12px', borderRadius: 20, border: `1px solid ${(filter || '') === (f === 'all' ? '' : f) ? D.teal : D.border}`,
              background: (filter || '') === (f === 'all' ? '' : f) ? `${D.teal}15` : 'transparent',
              color: (filter || '') === (f === 'all' ? '' : f) ? D.teal : D.muted, fontSize: 12, cursor: 'pointer', textTransform: 'capitalize',
            }}>{f}</button>
          ))}
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Location', 'Field', 'Source', 'Status', 'Old → New', 'Date'].map(h => (
              <th key={h} style={{ fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {updates.map(u => (
            <tr key={u.id} style={{ borderBottom: `1px solid ${D.border}22` }}>
              <td style={{ padding: '10px', fontSize: 13 }}>{locName(u.location_id)}</td>
              <td style={{ padding: '10px', fontSize: 13, color: D.teal }}>{fieldLabel(u.field_name)}</td>
              <td style={{ padding: '10px' }}><span style={sBadge(`${D.purple}22`, D.purple)}>{u.source}</span></td>
              <td style={{ padding: '10px' }}><span style={sBadge(`${statusColor[u.status]}22`, statusColor[u.status])}>{u.status}</span></td>
              <td style={{ padding: '10px', fontSize: 11, color: D.muted, maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(u.old_value || '').substring(0, 30)} → {(u.new_value || '').substring(0, 30)}
              </td>
              <td style={{ padding: '10px', fontSize: 11, color: D.muted, fontFamily: "'JetBrains Mono', monospace" }}>{new Date(u.detected_at).toLocaleDateString()}</td>
            </tr>
          ))}
          {updates.length === 0 && (
            <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: D.muted }}>No changes found</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BULK EDIT TAB
// ══════════════════════════════════════════════════════════════
function BulkEditTab({ locations, onSave, showToast }) {
  const [selectedLocs, setSelectedLocs] = useState(new Set());
  const [field, setField] = useState('description');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const fields = [
    { value: 'description', label: 'Description' },
    { value: 'phone', label: 'Phone' },
    { value: 'website_url', label: 'Website URL' },
    { value: 'services', label: 'Services (JSON)' },
    { value: 'hide_address', label: 'Hide Address' },
  ];

  const toggleLoc = (id) => {
    setSelectedLocs(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };

  const selectAll = () => {
    if (selectedLocs.size === locations.length) setSelectedLocs(new Set());
    else setSelectedLocs(new Set(locations.map(l => l.id)));
  };

  const handleApply = async () => {
    if (selectedLocs.size === 0) { showToast('Select at least one location'); return; }
    setSaving(true);
    try {
      let parsedValue = value;
      if (field === 'services') parsedValue = JSON.parse(value);
      if (field === 'hide_address') parsedValue = value === 'true';
      await adminFetch('/admin/gbp/locations/bulk-edit', {
        method: 'POST',
        body: JSON.stringify({ locationIds: [...selectedLocs], field, value: parsedValue }),
      });
      showToast(`Updated "${field}" for ${selectedLocs.size} location(s)`);
      onSave();
    } catch (e) { showToast(`Bulk edit failed: ${e.message}`); }
    setSaving(false);
  };

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>Bulk Edit Locations</div>

        <div style={{ marginBottom: 16 }}>
          <span style={sLabel}>Select Locations</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <button onClick={selectAll} style={sBtnOutline}>{selectedLocs.size === locations.length ? 'Deselect All' : 'Select All'}</button>
            {locations.map(l => (
              <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: selectedLocs.has(l.id) ? D.teal : D.muted, padding: '6px 12px', borderRadius: 8, border: `1px solid ${selectedLocs.has(l.id) ? D.teal : D.border}`, background: selectedLocs.has(l.id) ? `${D.teal}11` : 'transparent' }}>
                <input type="checkbox" checked={selectedLocs.has(l.id)} onChange={() => toggleLoc(l.id)} style={{ accentColor: D.teal }} />
                {l.name}
              </label>
            ))}
          </div>
        </div>

        <FieldGroup>
          <Field label="Field to Edit">
            <select value={field} onChange={e => setField(e.target.value)} style={{ ...sInput, cursor: 'pointer' }}>
              {fields.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
        </FieldGroup>

        <Field label="New Value">
          {field === 'description' ? (
            <textarea value={value} onChange={e => setValue(e.target.value)} rows={4} style={{ ...sInput, resize: 'vertical' }} placeholder="Enter the value to apply to all selected locations..." />
          ) : field === 'hide_address' ? (
            <select value={value} onChange={e => setValue(e.target.value)} style={{ ...sInput, cursor: 'pointer' }}>
              <option value="false">Show Address</option>
              <option value="true">Hide Address (SAB)</option>
            </select>
          ) : (
            <input value={value} onChange={e => setValue(e.target.value)} style={sInput} placeholder="Enter value..." />
          )}
        </Field>

        <button onClick={handleApply} disabled={saving || selectedLocs.size === 0} style={{ ...sBtn(D.teal, D.white), opacity: saving || selectedLocs.size === 0 ? 0.5 : 1 }}>
          {saving ? 'Applying...' : `Apply to ${selectedLocs.size} Location(s)`}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS TAB
// ══════════════════════════════════════════════════════════════
function NotificationsTab({ showToast }) {
  const [prefs, setPrefs] = useState({ frequency: 'daily', field_filters: [], enabled: true });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminFetch('/admin/gbp/notifications?email=admin@wavespestcontrol.com')
      .then(d => { if (d.preferences) setPrefs(d.preferences); })
      .catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminFetch('/admin/gbp/notifications', {
        method: 'PUT',
        body: JSON.stringify({ email: 'admin@wavespestcontrol.com', ...prefs, field_filters: prefs.field_filters || [] }),
      });
      showToast('Notification preferences saved');
    } catch (e) { showToast(`Save failed: ${e.message}`); }
    setSaving(false);
  };

  const fieldOptions = [
    'business_name', 'phone', 'address', 'website_url', 'regular_hours',
    'description', 'primary_category', 'photos', 'services', 'attributes',
  ];

  const toggleField = (f) => {
    const filters = prefs.field_filters || [];
    if (filters.includes(f)) setPrefs(p => ({ ...p, field_filters: filters.filter(x => x !== f) }));
    else setPrefs(p => ({ ...p, field_filters: [...filters, f] }));
  };

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={sCard}>
        <div style={{ fontSize: 16, fontWeight: 600, color: D.white, marginBottom: 16 }}>GBP Change Alerts</div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, color: D.text, marginBottom: 16 }}>
          <input type="checkbox" checked={prefs.enabled} onChange={e => setPrefs(p => ({ ...p, enabled: e.target.checked }))} style={{ accentColor: D.teal, width: 18, height: 18 }} />
          Enable notifications
        </label>

        <Field label="Frequency">
          <select value={prefs.frequency} onChange={e => setPrefs(p => ({ ...p, frequency: e.target.value }))} style={{ ...sInput, cursor: 'pointer' }}>
            <option value="realtime">Real-time (every change)</option>
            <option value="daily">Daily digest</option>
            <option value="weekly">Weekly digest</option>
            <option value="monthly">Monthly digest</option>
          </select>
        </Field>

        <div style={{ marginBottom: 16 }}>
          <span style={sLabel}>Alert on these fields only (leave empty = all fields)</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {fieldOptions.map(f => {
              const active = (prefs.field_filters || []).includes(f);
              return (
                <button key={f} onClick={() => toggleField(f)} style={{
                  padding: '6px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                  border: `1px solid ${active ? D.teal : D.border}`,
                  background: active ? `${D.teal}15` : 'transparent',
                  color: active ? D.teal : D.muted, textTransform: 'capitalize',
                }}>{f.replace(/_/g, ' ')}</button>
              );
            })}
          </div>
        </div>

        <button onClick={handleSave} disabled={saving} style={{ ...sBtn(D.teal, D.white), opacity: saving ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Save Preferences'}</button>
      </div>
    </div>
  );
}

// ── Shared layout helpers ──
function Field({ label, children }) {
  return <div style={{ marginBottom: 16 }}><span style={sLabel}>{label}</span>{children}</div>;
}

function FieldGroup({ children }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>;
}
