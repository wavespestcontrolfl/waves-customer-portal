import React, { useState, useEffect, useCallback } from 'react';

const API = '/api/admin/compliance-v2';
const headers = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

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

// ── Stat Card ──
function StatCard({ label, value, sub, color = '#00e5ff' }) {
  return (
    <div style={{ background: '#1e1e2e', borderRadius: 10, padding: '18px 22px', minWidth: 160, flex: 1 }}>
      <div style={{ color: '#999', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ color, fontSize: 28, fontWeight: 700, margin: '6px 0 2px' }}>{value ?? '—'}</div>
      {sub && <div style={{ color: '#777', fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

// ═══════════ DASHBOARD TAB ═══════════
function DashboardTab({ token }) {
  const { data, loading } = useFetch(`${API}/dashboard`, token);
  const { data: nData } = useFetch(`${API}/nitrogen-status`, token);

  if (loading || !data) return <div style={{ color: '#aaa', padding: 20 }}>Loading dashboard...</div>;

  const blackoutActive = nData?.activeBlackoutCount > 0;

  return (
    <div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 20 }}>
        <StatCard label="YTD Applications" value={data.ytdApplications} />
        <StatCard label="Unique Products" value={data.uniqueProducts} color="#4caf50" />
        <StatCard label="Warnings" value={data.warningCount} color={data.warningCount > 0 ? '#ff9800' : '#4caf50'} />
        <StatCard label="Licensed Techs" value={data.licensedTechs}
          sub={data.expiringLicenses > 0 ? `${data.expiringLicenses} expiring soon` : 'All current'}
          color={data.expiringLicenses > 0 ? '#ff9800' : '#4caf50'} />
        <StatCard label="Restricted Use Apps" value={data.restrictedUseApps} color="#e91e63" />
      </div>

      {/* Nitrogen blackout card */}
      <div style={{
        background: blackoutActive ? '#3e2723' : '#1b2e1b', borderRadius: 10, padding: 18, marginBottom: 20,
        border: `1px solid ${blackoutActive ? '#ff5722' : '#4caf50'}`
      }}>
        <div style={{ color: blackoutActive ? '#ff8a65' : '#81c784', fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
          {blackoutActive ? 'NITROGEN BLACKOUT ACTIVE' : 'No Active Nitrogen Blackout'}
        </div>
        {nData?.blackoutPeriods?.map((b, i) => (
          <div key={i} style={{ color: '#ccc', fontSize: 13, marginBottom: 4 }}>
            {b.jurisdiction?.replace('_', ' ')}: {b.start} to {b.end}
          </div>
        ))}
      </div>

      {/* Recent applications */}
      <h3 style={{ color: '#ddd', marginBottom: 10 }}>Recent Applications</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#999', fontSize: 12, textTransform: 'uppercase', borderBottom: '1px solid #333' }}>
            <th style={{ textAlign: 'left', padding: 8 }}>Date</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Product</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Customer</th>
            <th style={{ textAlign: 'left', padding: 8 }}>Technician</th>
          </tr>
        </thead>
        <tbody>
          {data.recentApplications?.map(a => (
            <tr key={a.id} style={{ borderBottom: '1px solid #2a2a3a' }}>
              <td style={{ padding: 8, color: '#ccc' }}>{a.date}</td>
              <td style={{ padding: 8, color: '#eee' }}>{a.product || '—'}</td>
              <td style={{ padding: 8, color: '#ccc' }}>{a.customer || '—'}</td>
              <td style={{ padding: 8, color: '#ccc' }}>{a.tech || '—'}</td>
            </tr>
          ))}
          {!data.recentApplications?.length && (
            <tr><td colSpan={4} style={{ padding: 20, color: '#666', textAlign: 'center' }}>No applications recorded yet</td></tr>
          )}
        </tbody>
      </table>
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

  const inp = { background: '#1e1e2e', border: '1px solid #444', borderRadius: 6, color: '#eee', padding: '6px 10px', fontSize: 13 };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <input type="date" style={inp} value={filters.startDate} onChange={e => setFilters(f => ({ ...f, startDate: e.target.value, page: 0 }))} />
        <input type="date" style={inp} value={filters.endDate} onChange={e => setFilters(f => ({ ...f, endDate: e.target.value, page: 0 }))} />
        <input placeholder="Product name..." style={{ ...inp, width: 180 }} value={filters.productName}
          onChange={e => setFilters(f => ({ ...f, productName: e.target.value, page: 0 }))} />
        <button onClick={exportCSV}
          style={{ background: '#00796b', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer', fontWeight: 600 }}>
          Export for DACS
        </button>
      </div>
      {loading ? <div style={{ color: '#aaa' }}>Loading...</div> : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr style={{ color: '#999', fontSize: 11, textTransform: 'uppercase', borderBottom: '1px solid #333' }}>
                  {['Date', 'Product', 'Active Ingredient', 'EPA Reg #', 'Rate', 'Customer', 'Tech', 'Method'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: 8 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data?.applications?.map(a => (
                  <tr key={a.id} style={{ borderBottom: '1px solid #2a2a3a' }}>
                    <td style={{ padding: 8, color: '#ccc', whiteSpace: 'nowrap' }}>{a.applicationDate}</td>
                    <td style={{ padding: 8, color: '#eee' }}>{a.productName}</td>
                    <td style={{ padding: 8, color: '#aaa', fontSize: 12 }}>{a.activeIngredient || '—'}</td>
                    <td style={{ padding: 8, color: '#aaa', fontSize: 12 }}>{a.epaRegNumber || '—'}</td>
                    <td style={{ padding: 8, color: '#ccc', fontSize: 12 }}>{a.applicationRate ? `${a.applicationRate} ${a.rateUnit || ''}` : '—'}</td>
                    <td style={{ padding: 8, color: '#ccc' }}>{a.customerName || '—'}</td>
                    <td style={{ padding: 8, color: '#ccc' }}>{a.techName || '—'}</td>
                    <td style={{ padding: 8, color: '#aaa', fontSize: 12 }}>{a.applicationMethod || '—'}</td>
                  </tr>
                ))}
                {!data?.applications?.length && (
                  <tr><td colSpan={8} style={{ padding: 20, color: '#666', textAlign: 'center' }}>No applications found</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
            <span style={{ color: '#888', fontSize: 13 }}>{data?.total || 0} total records</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={filters.page === 0} onClick={() => setFilters(f => ({ ...f, page: f.page - 1 }))}
                style={{ background: '#333', color: '#ccc', border: 'none', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}>Prev</button>
              <button disabled={(data?.applications?.length || 0) < limit}
                onClick={() => setFilters(f => ({ ...f, page: f.page + 1 }))}
                style={{ background: '#333', color: '#ccc', border: 'none', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}>Next</button>
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

  const statusColor = (s) => ({ ok: '#4caf50', warning: '#ff9800', exceeded: '#f44336', blackout_active: '#f44336' }[s] || '#999');

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center' }}>
        <input placeholder="Customer ID..." value={customerId} onChange={e => setCustomerId(e.target.value)}
          style={{ background: '#1e1e2e', border: '1px solid #444', borderRadius: 6, color: '#eee', padding: '6px 10px', width: 300 }} />
        <button onClick={lookup}
          style={{ background: '#1976d2', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', cursor: 'pointer' }}>
          Check Limits
        </button>
      </div>
      {loading && <div style={{ color: '#aaa' }}>Checking...</div>}
      {result?.limits && (
        <div>
          <h4 style={{ color: '#ddd', marginBottom: 10 }}>{result.customerName}</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#999', fontSize: 11, textTransform: 'uppercase', borderBottom: '1px solid #333' }}>
                {['Type', 'Limit', 'Current', 'Status', 'Severity', 'Description'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: 8 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.limits.map((l, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #2a2a3a' }}>
                  <td style={{ padding: 8, color: '#ccc' }}>{l.limitType?.replace(/_/g, ' ')}</td>
                  <td style={{ padding: 8, color: '#eee' }}>{l.limitValue}</td>
                  <td style={{ padding: 8, color: '#eee' }}>{l.currentUsage}</td>
                  <td style={{ padding: 8 }}><span style={{ color: statusColor(l.status), fontWeight: 600 }}>{l.status?.replace(/_/g, ' ').toUpperCase()}</span></td>
                  <td style={{ padding: 8, color: l.severity === 'hard_block' ? '#f44336' : '#ff9800' }}>{l.severity}</td>
                  <td style={{ padding: 8, color: '#999', fontSize: 12, maxWidth: 300 }}>{l.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Nitrogen section */}
      <h3 style={{ color: '#ddd', marginTop: 30, marginBottom: 10 }}>Nitrogen Status — All Lawn Customers</h3>
      {nData?.customers?.length ? (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: '#999', fontSize: 11, textTransform: 'uppercase', borderBottom: '1px solid #333' }}>
              {['Customer', 'City', 'County', 'Lawn Type', 'N Apps YTD', 'Blackout'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: 8 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nData.customers.map(c => (
              <tr key={c.customerId} style={{ borderBottom: '1px solid #2a2a3a' }}>
                <td style={{ padding: 8, color: '#ccc' }}>{c.customerName}</td>
                <td style={{ padding: 8, color: '#aaa' }}>{c.city}</td>
                <td style={{ padding: 8, color: '#aaa' }}>{c.county?.replace('_', ' ')}</td>
                <td style={{ padding: 8, color: '#aaa' }}>{c.lawnType}</td>
                <td style={{ padding: 8, color: '#eee' }}>{c.nitrogenAppsYTD}</td>
                <td style={{ padding: 8 }}>
                  <span style={{ color: c.blackoutActive ? '#f44336' : '#4caf50', fontWeight: 600 }}>
                    {c.blackoutActive ? 'ACTIVE' : 'Clear'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div style={{ color: '#666' }}>No lawn customers found</div>}
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
    const colors = { active: '#4caf50', expiring_soon: '#ff9800', expired: '#f44336', none: '#666' };
    return <span style={{ color: colors[s] || '#999', fontWeight: 600, fontSize: 12, textTransform: 'uppercase' }}>{s?.replace('_', ' ')}</span>;
  };

  if (loading) return <div style={{ color: '#aaa', padding: 20 }}>Loading...</div>;

  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#999', fontSize: 11, textTransform: 'uppercase', borderBottom: '1px solid #333' }}>
            {['Technician', 'License #', 'Expiry', 'Categories', 'Status', ''].map(h => (
              <th key={h} style={{ textAlign: 'left', padding: 8 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data?.technicians?.map(t => (
            <tr key={t.id} style={{ borderBottom: '1px solid #2a2a3a' }}>
              <td style={{ padding: 8, color: '#eee' }}>{t.name}</td>
              {editing === t.id ? (
                <>
                  <td style={{ padding: 8 }}>
                    <input value={form.fl_applicator_license} onChange={e => setForm(f => ({ ...f, fl_applicator_license: e.target.value }))}
                      style={{ background: '#2a2a3a', border: '1px solid #555', color: '#eee', borderRadius: 4, padding: '4px 8px', width: 120 }} />
                  </td>
                  <td style={{ padding: 8 }}>
                    <input type="date" value={form.license_expiry} onChange={e => setForm(f => ({ ...f, license_expiry: e.target.value }))}
                      style={{ background: '#2a2a3a', border: '1px solid #555', color: '#eee', borderRadius: 4, padding: '4px 8px' }} />
                  </td>
                  <td style={{ padding: 8, color: '#aaa', fontSize: 12 }}>—</td>
                  <td style={{ padding: 8 }}>{statusBadge(t.licenseStatus)}</td>
                  <td style={{ padding: 8 }}>
                    <button onClick={save} style={{ background: '#4caf50', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', marginRight: 6 }}>Save</button>
                    <button onClick={() => setEditing(null)} style={{ background: '#555', color: '#ccc', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}>Cancel</button>
                  </td>
                </>
              ) : (
                <>
                  <td style={{ padding: 8, color: '#ccc' }}>{t.license || '—'}</td>
                  <td style={{ padding: 8, color: '#ccc' }}>{t.licenseExpiry || '—'}</td>
                  <td style={{ padding: 8, color: '#aaa', fontSize: 12 }}>
                    {Array.isArray(t.licenseCategories) ? t.licenseCategories.join(', ') : '—'}
                  </td>
                  <td style={{ padding: 8 }}>{statusBadge(t.licenseStatus)}</td>
                  <td style={{ padding: 8 }}>
                    <button onClick={() => startEdit(t)}
                      style={{ background: '#1976d2', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12 }}>Edit</button>
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
    <div style={{ background: '#121218', minHeight: '100vh', color: '#eee', padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Chemical Compliance & DACS Reporting</h1>
      <p style={{ color: '#888', fontSize: 14, marginBottom: 20 }}>FL DACS compliance, product limits, nitrogen blackouts, technician licenses</p>

      <div style={{ display: 'flex', gap: 4, marginBottom: 24, borderBottom: '1px solid #333', paddingBottom: 0 }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              background: tab === t.key ? '#1e1e2e' : 'transparent', color: tab === t.key ? '#00e5ff' : '#888',
              border: 'none', borderBottom: tab === t.key ? '2px solid #00e5ff' : '2px solid transparent',
              padding: '10px 20px', cursor: 'pointer', fontSize: 14, fontWeight: tab === t.key ? 700 : 400,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <DashboardTab token={token} />}
      {tab === 'log' && <ApplicationLogTab token={token} />}
      {tab === 'limits' && <ProductLimitsTab token={token} />}
      {tab === 'licenses' && <LicensesTab token={token} />}
    </div>
  );
}
