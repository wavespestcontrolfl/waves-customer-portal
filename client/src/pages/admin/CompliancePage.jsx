import React, { useState, useEffect, useCallback } from 'react';

const API = '/api/admin/compliance-v2';
const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// V2 token pass — mirrors the palette used across EmailPage, ReviewsPage,
// ServiceLibraryPage, etc. Kept as a local const so a one-page restyle
// doesn't pull in a brand-new import surface.
const D = {
  bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7',
  text: '#27272A', muted: '#71717A', heading: '#09090B',
  green: '#15803D', amber: '#A16207', red: '#991B1B',
  ink: '#18181B',
};

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 18 };
const sInput = { padding: '8px 12px', background: D.card, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none' };
const thS = { fontSize: 11, color: D.muted, fontWeight: 600, textAlign: 'left', padding: '12px 14px', background: '#F8F8F8', borderBottom: `1px solid ${D.border}` };
const tdS = { padding: '12px 14px', borderTop: `1px solid ${D.border}`, fontSize: 13, color: D.text, verticalAlign: 'middle' };
const sTableWrap = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, overflow: 'hidden' };

function useFetch(url, token, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fetch(url, { headers: headers(token) })
      .then(r => r.json()).then(setData).catch(console.error).finally(() => setLoading(false));
  }, [url, token]);
  useEffect(() => { reload(); }, [reload, ...deps]);
  return { data, loading, reload };
}

function StatCard({ label, value, sub, accent = D.ink }) {
  return (
    <div style={{ ...sCard, padding: '16px 20px', minWidth: 160, flex: 1 }}>
      <div style={{ color: D.muted, fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ color: accent, fontSize: 28, fontWeight: 700, margin: '6px 0 2px', fontFamily: "'JetBrains Mono', monospace" }}>{value ?? '—'}</div>
      {sub && <div style={{ color: D.muted, fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

// ═══════════ DASHBOARD TAB ═══════════
function DashboardTab({ token }) {
  const { data, loading } = useFetch(`${API}/dashboard`, token);
  const { data: nData } = useFetch(`${API}/nitrogen-status`, token);

  if (loading || !data) return <div style={{ color: D.muted, padding: 20 }}>Loading dashboard…</div>;

  const blackoutActive = nData?.activeBlackoutCount > 0;

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatCard label="YTD Applications" value={data.ytdApplications} />
        <StatCard label="Unique Products" value={data.uniqueProducts} accent={D.green} />
        <StatCard label="Warnings" value={data.warningCount} accent={data.warningCount > 0 ? D.amber : D.green} />
        <StatCard label="Licensed Techs" value={data.licensedTechs}
          sub={data.expiringLicenses > 0 ? `${data.expiringLicenses} expiring soon` : 'All current'}
          accent={data.expiringLicenses > 0 ? D.amber : D.green} />
        <StatCard label="Restricted Use Apps" value={data.restrictedUseApps} accent={D.red} />
      </div>

      {/* Nitrogen blackout card */}
      <div style={{
        ...sCard, marginBottom: 20,
        background: blackoutActive ? '#FEF2F2' : '#F0FDF4',
        borderColor: blackoutActive ? '#FCA5A5' : '#86EFAC',
      }}>
        <div style={{ color: blackoutActive ? D.red : D.green, fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
          {blackoutActive ? 'Nitrogen Blackout Active' : 'No Active Nitrogen Blackout'}
        </div>
        {nData?.blackoutPeriods?.map((b, i) => (
          <div key={i} style={{ color: D.text, fontSize: 13, marginBottom: 4 }}>
            {b.jurisdiction?.replace('_', ' ')}: {b.start} to {b.end}
          </div>
        ))}
      </div>

      {/* Recent applications */}
      <div style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginBottom: 10 }}>Recent Applications</div>
      <div style={sTableWrap}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Date', 'Product', 'Customer', 'Technician'].map(h => <th key={h} style={thS}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.recentApplications?.map(a => (
              <tr key={a.id}>
                <td style={tdS}>{a.date}</td>
                <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>{a.product || '—'}</td>
                <td style={tdS}>{a.customer || '—'}</td>
                <td style={tdS}>{a.tech || '—'}</td>
              </tr>
            ))}
            {!data.recentApplications?.length && (
              <tr><td colSpan={4} style={{ ...tdS, color: D.muted, textAlign: 'center', padding: 24 }}>No applications recorded yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════ APPLICATION LOG TAB ═══════════
function ApplicationLogTab({ token }) {
  const [filters, setFilters] = useState({ startDate: '', endDate: '', productName: '', page: 0 });
  const limit = 25;
  const qs = new URLSearchParams({
    ...(filters.startDate && { startDate: filters.startDate }),
    ...(filters.endDate && { endDate: filters.endDate }),
    ...(filters.productName && { productName: filters.productName }),
    limit: String(limit), offset: String(filters.page * limit),
  }).toString();
  const { data, loading } = useFetch(`${API}/applications?${qs}`, token, [qs]);

  const exportCSV = async () => {
    const params = new URLSearchParams({
      ...(filters.startDate && { startDate: filters.startDate }),
      ...(filters.endDate && { endDate: filters.endDate }),
    }).toString();
    const res = await fetch(`${API}/report/export?${params}`, { headers: headers(token) });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'dacs-report.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <input type="date" style={sInput} value={filters.startDate} onChange={e => setFilters(f => ({ ...f, startDate: e.target.value, page: 0 }))} />
        <input type="date" style={sInput} value={filters.endDate} onChange={e => setFilters(f => ({ ...f, endDate: e.target.value, page: 0 }))} />
        <input placeholder="Product name…" style={{ ...sInput, width: 200 }} value={filters.productName}
          onChange={e => setFilters(f => ({ ...f, productName: e.target.value, page: 0 }))} />
        <button onClick={exportCSV}
          style={{ background: D.ink, color: D.card, border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
          Export for DACS
        </button>
      </div>
      {loading ? <div style={{ color: D.muted }}>Loading…</div> : (
        <>
          <div style={sTableWrap}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                <thead>
                  <tr>
                    {['Date', 'Product', 'Active Ingredient', 'EPA Reg #', 'Rate', 'Customer', 'Tech', 'Method'].map(h => (
                      <th key={h} style={thS}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data?.applications?.map(a => (
                    <tr key={a.id}>
                      <td style={{ ...tdS, whiteSpace: 'nowrap' }}>{a.applicationDate}</td>
                      <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>{a.productName}</td>
                      <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>{a.activeIngredient || '—'}</td>
                      <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>{a.epaRegNumber || '—'}</td>
                      <td style={{ ...tdS, fontSize: 12 }}>{a.applicationRate ? `${a.applicationRate} ${a.rateUnit || ''}` : '—'}</td>
                      <td style={tdS}>{a.customerName || '—'}</td>
                      <td style={tdS}>{a.techName || '—'}</td>
                      <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>{a.applicationMethod || '—'}</td>
                    </tr>
                  ))}
                  {!data?.applications?.length && (
                    <tr><td colSpan={8} style={{ ...tdS, color: D.muted, textAlign: 'center', padding: 24 }}>No applications found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span style={{ color: D.muted, fontSize: 13 }}>{data?.total || 0} total records</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={filters.page === 0} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}
                style={{ background: D.card, color: D.text, border: `1px solid ${D.border}`, borderRadius: 8, padding: '6px 14px', cursor: filters.page === 0 ? 'not-allowed' : 'pointer', fontSize: 13, opacity: filters.page === 0 ? 0.5 : 1 }}>Prev</button>
              <button disabled={(data?.applications?.length || 0) < limit}
                onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}
                style={{ background: D.card, color: D.text, border: `1px solid ${D.border}`, borderRadius: 8, padding: '6px 14px', cursor: (data?.applications?.length || 0) < limit ? 'not-allowed' : 'pointer', fontSize: 13, opacity: (data?.applications?.length || 0) < limit ? 0.5 : 1 }}>Next</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════ PRODUCT LIMITS TAB ═══════════
function ProductLimitsTab({ token }) {
  const [customerId, setCustomerId] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const { data: nData } = useFetch(`${API}/nitrogen-status`, token);

  const lookup = async () => {
    if (!customerId) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/product-limits?customer_id=${customerId}`, { headers: headers(token) });
      setResult(await r.json());
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const statusColor = (s) => ({ ok: D.green, warning: D.amber, exceeded: D.red, blackout_active: D.red }[s] || D.muted);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <input placeholder="Customer ID…" value={customerId} onChange={e => setCustomerId(e.target.value)}
          style={{ ...sInput, width: 320 }} />
        <button onClick={lookup}
          style={{ background: D.ink, color: D.card, border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          Check Limits
        </button>
      </div>
      {loading && <div style={{ color: D.muted }}>Checking…</div>}
      {result?.limits && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginBottom: 10 }}>{result.customerName}</div>
          <div style={sTableWrap}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Type', 'Limit', 'Current', 'Status', 'Severity', 'Description'].map(h => <th key={h} style={thS}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {result.limits.map((l, i) => (
                  <tr key={i}>
                    <td style={tdS}>{l.limitType?.replace(/_/g, ' ')}</td>
                    <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>{l.limitValue}</td>
                    <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>{l.currentUsage}</td>
                    <td style={tdS}><span style={{ color: statusColor(l.status), fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{l.status?.replace(/_/g, ' ')}</span></td>
                    <td style={{ ...tdS, color: l.severity === 'hard_block' ? D.red : D.amber }}>{l.severity}</td>
                    <td style={{ ...tdS, color: D.muted, fontSize: 12, maxWidth: 320 }}>{l.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ fontSize: 15, fontWeight: 700, color: D.heading, marginTop: 24, marginBottom: 10 }}>Nitrogen Status — All Lawn Customers</div>
      {nData?.customers?.length ? (
        <div style={sTableWrap}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Customer', 'City', 'County', 'Lawn Type', 'N Apps YTD', 'Blackout'].map(h => <th key={h} style={thS}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {nData.customers.map(c => (
                <tr key={c.customerId}>
                  <td style={tdS}>{c.customerName}</td>
                  <td style={{ ...tdS, color: D.muted }}>{c.city}</td>
                  <td style={{ ...tdS, color: D.muted }}>{c.county?.replace('_', ' ')}</td>
                  <td style={{ ...tdS, color: D.muted }}>{c.lawnType}</td>
                  <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>{c.nitrogenAppsYTD}</td>
                  <td style={tdS}>
                    <span style={{ color: c.blackoutActive ? D.red : D.green, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      {c.blackoutActive ? 'Active' : 'Clear'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div style={{ color: D.muted }}>No lawn customers found</div>}
    </div>
  );
}

// ═══════════ LICENSES TAB ═══════════
function LicensesTab({ token }) {
  const { data, loading, reload } = useFetch(`${API}/licenses`, token);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});

  const startEdit = (t) => {
    setEditing(t.id);
    setForm({ fl_applicator_license: t.license || '', license_expiry: t.licenseExpiry || '', license_categories: t.licenseCategories || [] });
  };

  const save = async () => {
    await fetch(`${API}/licenses/${editing}`, {
      method: 'PUT', headers: headers(token),
      body: JSON.stringify(form),
    });
    setEditing(null);
    reload();
  };

  const statusBadge = (s) => {
    const colors = { active: D.green, expiring_soon: D.amber, expired: D.red, none: D.muted };
    return <span style={{ color: colors[s] || D.muted, fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{s?.replace('_', ' ')}</span>;
  };

  if (loading) return <div style={{ color: D.muted, padding: 20 }}>Loading…</div>;

  return (
    <div style={sTableWrap}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Technician', 'License #', 'Expiry', 'Categories', 'Status', ''].map(h => <th key={h} style={thS}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {data?.technicians?.map(t => (
            <tr key={t.id}>
              <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>{t.name}</td>
              {editing === t.id ? (
                <>
                  <td style={tdS}>
                    <input value={form.fl_applicator_license} onChange={e => setForm(f => ({ ...f, fl_applicator_license: e.target.value }))}
                      style={{ ...sInput, width: 140 }} />
                  </td>
                  <td style={tdS}>
                    <input type="date" value={form.license_expiry} onChange={e => setForm(f => ({ ...f, license_expiry: e.target.value }))}
                      style={sInput} />
                  </td>
                  <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>—</td>
                  <td style={tdS}>{statusBadge(t.licenseStatus)}</td>
                  <td style={tdS}>
                    <button onClick={save} style={{ background: D.green, color: D.card, border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', marginRight: 6, fontSize: 12, fontWeight: 600 }}>Save</button>
                    <button onClick={() => setEditing(null)} style={{ background: 'transparent', color: D.muted, border: `1px solid ${D.border}`, borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td style={tdS}>{t.license || '—'}</td>
                  <td style={tdS}>{t.licenseExpiry || '—'}</td>
                  <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>
                    {Array.isArray(t.licenseCategories) ? t.licenseCategories.join(', ') : '—'}
                  </td>
                  <td style={tdS}>{statusBadge(t.licenseStatus)}</td>
                  <td style={tdS}>
                    <button onClick={() => startEdit(t)}
                      style={{ background: 'transparent', color: D.ink, border: `1px solid ${D.border}`, borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>Edit</button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════ MAIN PAGE ═══════════
export default function CompliancePage() {
  const [tab, setTab] = useState('dashboard');
  const token = localStorage.getItem('adminToken');

  const tabs = [
    { key: 'dashboard', label: 'Dashboard' },
    { key: 'log', label: 'Application Log' },
    { key: 'limits', label: 'Product Limits' },
    { key: 'licenses', label: 'Licenses' },
  ];

  return (
    <div style={{ background: D.bg, minHeight: '100vh', padding: '24px 32px' }}>
      <h1 style={{ fontSize: 28, fontWeight: 400, color: D.heading, letterSpacing: '-0.015em', margin: '0 0 24px' }}>
        Chemical Compliance &amp; DACS Reporting
      </h1>

      {/* Centered Pipeline-page tab strip — matches Customers / Pipeline /
          Dispatch so all the multi-tab admin surfaces share one shape. */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
        <div
          style={{
            display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center',
            gap: 4, padding: 4,
            background: '#F4F4F5', borderRadius: 10, border: `1px solid ${D.border}`,
          }}
        >
          {tabs.map(t => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                style={{
                  padding: '10px 24px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  background: active ? D.ink : 'transparent',
                  color: active ? D.card : D.muted,
                  fontSize: 14, fontWeight: 700, transition: 'all 0.2s',
                  fontFamily: "'DM Sans', sans-serif",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'dashboard' && <DashboardTab token={token} />}
      {tab === 'log' && <ApplicationLogTab token={token} />}
      {tab === 'limits' && <ProductLimitsTab token={token} />}
      {tab === 'licenses' && <LicensesTab token={token} />}
    </div>
  );
}
