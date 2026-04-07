import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', purple: '#8b5cf6', text: '#e2e8f0', muted: '#94a3b8', white: '#fff', input: '#0f172a' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12 };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600 });
const sInput = { padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const thS = { fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` };
const tdS = { padding: '10px', borderBottom: `1px solid ${D.border}22`, fontSize: 13 };

export default function InventoryPage() {
  const [tab, setTab] = useState('products');
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState('');
  const [productFilter, setProductFilter] = useState('all');

  useEffect(() => { adminFetch('/admin/inventory/stats').then(setStats).catch(() => {}); }, []);
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  const tabs = [
    { key: 'products', label: 'Products' },
    { key: 'vendors', label: 'Vendors' },
    { key: 'approvals', label: 'Approvals', badge: stats?.approvals?.pending },
    { key: 'margins', label: 'Service Margins' },
    { key: 'scrape', label: 'Scrape Health' },
  ];

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: D.white }}>Procurement Intelligence</div>
          <div style={{ fontSize: 13, color: D.muted, marginTop: 2 }}>Products, vendor pricing, approvals & COGS</div>
        </div>
      </div>

      {/* Stats row */}
      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Products', value: stats.products?.total, color: D.white, filter: 'all' },
            { label: 'Priced', value: stats.products?.priced, color: D.green, filter: 'priced' },
            { label: 'Needs Price', value: stats.products?.needsPrice, color: D.amber, filter: 'needs_price' },
            { label: 'Vendors', value: stats.vendors?.total, color: D.teal, action: () => setTab('vendors') },
            { label: 'Pending Approvals', value: stats.approvals?.pending, color: stats.approvals?.pending > 0 ? D.amber : D.green, action: () => setTab('approvals') },
            { label: 'Scrape Jobs', value: stats.scrapeJobs?.completed, color: D.purple, action: () => setTab('scraping') },
          ].map(s => (
            <div key={s.label} onClick={() => {
              if (s.action) { s.action(); }
              else if (s.filter) { setTab('products'); setProductFilter?.(s.filter); }
            }} style={{ ...sCard, flex: '1 1 120px', minWidth: 120, marginBottom: 0, textAlign: 'center', cursor: 'pointer', border: `1px solid ${D.border}`, transition: 'border-color 0.2s' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: s.color }}>{s.value ?? 0}</div>
              <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}` }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500,
            background: tab === t.key ? D.teal : 'transparent', color: tab === t.key ? D.white : D.muted,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {t.label}
            {t.badge > 0 && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 10, background: `${D.amber}33`, color: D.amber, fontWeight: 700 }}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {tab === 'products' && <ProductsTab showToast={showToast} filter={productFilter} onFilterChange={setProductFilter} />}
      {tab === 'vendors' && <VendorsTab showToast={showToast} />}
      {tab === 'approvals' && <ApprovalsTab showToast={showToast} onUpdate={() => adminFetch('/admin/inventory/stats').then(setStats).catch(() => {})} />}
      {tab === 'margins' && <MarginsTab showToast={showToast} />}
      {tab === 'scrape' && <ScrapeTab showToast={showToast} />}

      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PRODUCTS TAB
// ══════════════════════════════════════════════════════════════
function ProductsTab({ showToast, filter = 'all', onFilterChange }) {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [vendors, setVendors] = useState([]);

  const load = useCallback(async () => {
    const [pData, vData] = await Promise.all([
      adminFetch(`/admin/inventory?search=${encodeURIComponent(search)}&category=${encodeURIComponent(catFilter)}&limit=100`),
      adminFetch('/admin/inventory/vendors'),
    ]);
    setProducts(pData.products || []);
    setCategories(pData.categories || []);
    setVendors(vData.vendors || []);
    setLoading(false);
  }, [search, catFilter]);

  useEffect(() => { load(); }, [load]);

  const savePrice = async (productId, vendorId, price, quantity) => {
    try {
      await adminFetch(`/admin/inventory/${productId}/pricing`, {
        method: 'PUT', body: JSON.stringify({ vendorId, price: parseFloat(price), quantity }),
      });
      showToast('Price saved');
      load();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading products...</div>;

  return (
    <div>
      {/* Filter pills */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          { key: 'all', label: 'All Products' },
          { key: 'priced', label: 'Priced' },
          { key: 'needs_price', label: 'Needs Price' },
        ].map(f => (
          <button key={f.key} onClick={() => onFilterChange?.(f.key)} style={{
            padding: '6px 14px', borderRadius: 20, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: filter === f.key ? D.teal : D.card, color: filter === f.key ? D.white : D.muted,
          }}>{f.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." style={{ ...sInput, flex: 1, minWidth: 200 }} />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ ...sInput, cursor: 'pointer', minWidth: 150 }}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
        </select>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          {['Product', 'Category', 'Active Ingredient', 'Size', 'Best Price', 'Vendor', 'Status', ''].map(h => <th key={h} style={thS}>{h}</th>)}
        </tr></thead>
        <tbody>
          {products.filter(p => {
            if (filter === 'priced') return p.bestPrice && p.bestPrice > 0;
            if (filter === 'needs_price') return !p.bestPrice || p.bestPrice === 0;
            return true;
          }).map(p => (
            <>
              <tr key={p.id} onClick={() => setExpanded(expanded === p.id ? null : p.id)} style={{ cursor: 'pointer', background: expanded === p.id ? `${D.teal}08` : 'transparent' }}>
                <td style={{ ...tdS, fontWeight: 600, color: D.white }}>{p.name}</td>
                <td style={tdS}><span style={sBadge(`${D.teal}22`, D.teal)}>{p.category}</span></td>
                <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>{p.activeIngredient || '—'}</td>
                <td style={{ ...tdS, fontSize: 12 }}>{p.containerSize || '—'}</td>
                <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace", color: p.bestPrice ? D.green : D.muted }}>{p.bestPrice ? `$${p.bestPrice.toFixed(2)}` : '—'}</td>
                <td style={{ ...tdS, fontSize: 12 }}>{p.bestVendor || '—'}</td>
                <td style={tdS}>{p.needsPricing ? <span style={sBadge(`${D.amber}22`, D.amber)}>Needs Price</span> : <span style={sBadge(`${D.green}22`, D.green)}>Priced</span>}</td>
                <td style={{ ...tdS, fontSize: 11, color: D.muted }}>{p.vendorPricing.length} vendor{p.vendorPricing.length !== 1 ? 's' : ''}</td>
              </tr>
              {expanded === p.id && (
                <tr key={`${p.id}-exp`}><td colSpan={8} style={{ padding: '0 10px 16px', background: `${D.teal}05` }}>
                  <ExpandedProduct product={p} vendors={vendors} onSave={savePrice} />
                </td></tr>
              )}
            </>
          ))}
        </tbody>
      </table>
      {products.length === 0 && <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No products found</div>}
    </div>
  );
}

function ExpandedProduct({ product, vendors, onSave }) {
  const [vendorId, setVendorId] = useState(vendors[0]?.id || '');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');

  return (
    <div style={{ padding: 12 }}>
      {/* Existing prices */}
      {product.vendorPricing.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Vendor Prices</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {product.vendorPricing.map((vp, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', background: D.input, borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: D.white, fontWeight: 600, minWidth: 140 }}>{vp.vendorName}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: vp.isBest ? D.green : D.text }}>${vp.price.toFixed(2)}</span>
                {vp.quantity && <span style={{ color: D.muted }}>{vp.quantity}</span>}
                {vp.isBest && <span style={sBadge(`${D.green}22`, D.green)}>Best</span>}
                {vp.url && <a href={vp.url} target="_blank" rel="noopener noreferrer" style={{ color: D.teal, fontSize: 11 }}>↗</a>}
                {vp.lastChecked && <span style={{ color: D.muted, fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>{new Date(vp.lastChecked).toLocaleDateString()}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* Add price */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Vendor</label>
          <select value={vendorId} onChange={e => setVendorId(e.target.value)} style={{ ...sInput, width: 160, cursor: 'pointer' }}>
            {vendors.filter(v => v.active).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Price</label>
          <input value={price} onChange={e => setPrice(e.target.value)} placeholder="$0.00" type="number" step="0.01" style={{ ...sInput, width: 90 }} />
        </div>
        <div>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Size</label>
          <input value={qty} onChange={e => setQty(e.target.value)} placeholder="32 oz" style={{ ...sInput, width: 90 }} />
        </div>
        <button onClick={() => { if (vendorId && price) onSave(product.id, vendorId, price, qty); }} style={sBtn(D.teal, D.white)}>Save</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// VENDORS TAB
// ══════════════════════════════════════════════════════════════
function VendorsTab({ showToast }) {
  const [vendors, setVendors] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => adminFetch('/admin/inventory/vendors').then(d => { setVendors(d.vendors || []); setLoading(false); }).catch(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const save = async (id, data) => {
    try {
      await adminFetch(`/admin/inventory/vendors/${id}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('Vendor updated');
      load();
      setEditing(null);
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading vendors...</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {vendors.map(v => (
        <div key={v.id} style={{ ...sCard, marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>{v.name}</div>
              <div style={{ fontSize: 11, color: D.muted }}>{v.type}</div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {v.scrapingEnabled && <span style={sBadge(`${D.green}22`, D.green)}>Scrape</span>}
              {v.hasCredentials && <span style={sBadge(`${D.teal}22`, D.teal)}>Login</span>}
              {!v.active && <span style={sBadge(`${D.red}22`, D.red)}>Inactive</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: D.muted, marginBottom: 8 }}>
            <span>{v.productCount} products</span>
            <span>{v.bestPriceCount} best prices</span>
          </div>
          {v.lastScrapeAt && <div style={{ fontSize: 11, color: D.muted }}>Last scrape: {new Date(v.lastScrapeAt).toLocaleDateString()} — <span style={{ color: v.lastScrapeStatus === 'completed' ? D.green : D.amber }}>{v.lastScrapeStatus}</span></div>}
          {v.website && <a href={v.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, display: 'block', marginTop: 4 }}>{v.website}</a>}

          {editing === v.id ? (
            <VendorEditForm vendor={v} onSave={save} onCancel={() => setEditing(null)} />
          ) : (
            <button onClick={() => setEditing(v.id)} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}`, marginTop: 8, width: '100%', fontSize: 11 }}>Edit Credentials</button>
          )}
        </div>
      ))}
    </div>
  );
}

function VendorEditForm({ vendor, onSave, onCancel }) {
  const [form, setForm] = useState({
    loginUsername: vendor.loginUsername || '', loginEmail: vendor.loginEmail || '',
    loginPassword: '', accountNumber: vendor.accountNumber || '',
    loginUrl: vendor.loginUrl || '', notes: vendor.notes || '',
  });

  return (
    <div style={{ marginTop: 8, padding: 12, background: D.input, borderRadius: 8 }}>
      {[
        { key: 'loginUsername', label: 'Username', type: 'text' },
        { key: 'loginEmail', label: 'Email', type: 'email' },
        { key: 'loginPassword', label: 'Password', type: 'password' },
        { key: 'accountNumber', label: 'Account #', type: 'text' },
        { key: 'loginUrl', label: 'Login URL', type: 'url' },
      ].map(f => (
        <div key={f.key} style={{ marginBottom: 6 }}>
          <label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>{f.label}</label>
          <input value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} type={f.type} placeholder={f.label} style={{ ...sInput, width: '100%' }} />
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button onClick={() => onSave(vendor.id, form)} style={sBtn(D.teal, D.white)}>Save</button>
        <button onClick={onCancel} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}` }}>Cancel</button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// APPROVALS TAB
// ══════════════════════════════════════════════════════════════
function ApprovalsTab({ showToast, onUpdate }) {
  const [approvals, setApprovals] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);

  const load = () => adminFetch('/admin/inventory/approvals?status=pending&limit=100').then(d => { setApprovals(d.approvals || []); setLoading(false); }).catch(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const handleAction = async (id, action) => {
    try {
      await adminFetch(`/admin/inventory/approvals/${id}/${action}`, { method: 'POST' });
      showToast(`${action === 'approve' ? 'Approved' : 'Rejected'}`);
      load(); onUpdate();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  const handleBulk = async (action) => {
    try {
      await adminFetch('/admin/inventory/approvals/bulk', { method: 'POST', body: JSON.stringify({ ids: [...selected], action }) });
      showToast(`${action === 'approve' ? 'Approved' : 'Rejected'} ${selected.size} items`);
      setSelected(new Set()); load(); onUpdate();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  const toggleSel = (id) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading approvals...</div>;

  return (
    <div>
      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, padding: '10px 16px', background: D.card, border: `1px solid ${D.teal}`, borderRadius: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: D.teal }}>{selected.size} selected</span>
          <button onClick={() => handleBulk('approve')} style={sBtn(D.green, D.white)}>Approve All</button>
          <button onClick={() => handleBulk('reject')} style={sBtn(D.red, D.white)}>Reject All</button>
          <button onClick={() => setSelected(new Set())} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}` }}>Clear</button>
        </div>
      )}

      {approvals.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>No pending approvals
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {approvals.map(a => {
            const pct = a.price_change_pct || (a.old_price ? ((a.new_price - a.old_price) / a.old_price * 100).toFixed(1) : null);
            const isUp = pct > 0;
            return (
              <div key={a.id} style={{ ...sCard, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} style={{ accentColor: D.teal, cursor: 'pointer' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.white }}>{a.product_name}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{a.vendor_name} · {a.category}</div>
                </div>
                <div style={{ textAlign: 'center', minWidth: 80 }}>
                  {a.old_price && <div style={{ fontSize: 12, color: D.muted, textDecoration: 'line-through' }}>${parseFloat(a.old_price).toFixed(2)}</div>}
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: D.white }}>${parseFloat(a.new_price).toFixed(2)}</div>
                </div>
                {pct !== null && (
                  <span style={sBadge(isUp ? `${D.red}22` : `${D.green}22`, isUp ? D.red : D.green)}>
                    {isUp ? '+' : ''}{pct}%
                  </span>
                )}
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => handleAction(a.id, 'approve')} style={sBtn(D.green, D.white)}>✓</button>
                  <button onClick={() => handleAction(a.id, 'reject')} style={sBtn(D.red, D.white)}>✗</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SERVICE MARGINS TAB
// ══════════════════════════════════════════════════════════════
function MarginsTab({ showToast }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch('/admin/inventory/service-usage').then(d => { setServices(d.services || []); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading service margins...</div>;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>COGS by Service Line</div>
      {services.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>
          No service product mappings yet. Add products to services to see COGS breakdown.
        </div>
      ) : services.map(svc => (
        <div key={svc.serviceType} style={{ ...sCard }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: D.white }}>{svc.serviceType}</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700, color: D.green }}>
              ${svc.totalCost.toFixed(2)}/app
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              {['Product', 'Usage', 'Per 1000sf', 'Best Price', 'Cost/App'].map(h => <th key={h} style={thS}>{h}</th>)}
            </tr></thead>
            <tbody>
              {svc.products.map(p => (
                <tr key={p.id}>
                  <td style={{ ...tdS, fontWeight: 500 }}>{p.productName} {p.isPrimary && <span style={sBadge(`${D.teal}22`, D.teal)}>Primary</span>}</td>
                  <td style={{ ...tdS, fontSize: 12 }}>{p.usageAmount} {p.usageUnit}</td>
                  <td style={{ ...tdS, fontSize: 12 }}>{p.usagePer1000sf || '—'}</td>
                  <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace" }}>{p.bestPrice ? `$${parseFloat(p.bestPrice).toFixed(2)}` : '—'}</td>
                  <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace", color: D.green }}>{p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SCRAPE HEALTH TAB
// ══════════════════════════════════════════════════════════════
function ScrapeTab({ showToast }) {
  const [vendors, setVendors] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const [vData, jData] = await Promise.all([
      adminFetch('/admin/inventory/vendors'),
      adminFetch('/admin/inventory/scrape-jobs'),
    ]);
    setVendors((vData.vendors || []).filter(v => v.scrapingEnabled));
    setJobs(jData.jobs || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const triggerScrape = async (vendorId) => {
    try {
      const r = await adminFetch(`/admin/inventory/scrape-jobs/${vendorId}/trigger`, { method: 'POST' });
      showToast(r.message || 'Scrape triggered');
      load();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading scrape data...</div>;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 16 }}>Vendor Scrape Status</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 24 }}>
        {vendors.map(v => {
          const statusColor = v.lastScrapeStatus === 'completed' ? D.green : v.lastScrapeStatus === 'running' ? D.amber : v.lastScrapeStatus === 'failed' ? D.red : D.muted;
          return (
            <div key={v.id} style={{ ...sCard, marginBottom: 0, textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: D.white, marginBottom: 4 }}>{v.name}</div>
              <div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>{v.productCount} products · {v.scrapeSchedule || 'manual'}</div>
              <span style={sBadge(`${statusColor}22`, statusColor)}>{v.lastScrapeStatus || 'never'}</span>
              {v.lastScrapeAt && <div style={{ fontSize: 10, color: D.muted, marginTop: 4 }}>{new Date(v.lastScrapeAt).toLocaleDateString()}</div>}
              <button onClick={() => triggerScrape(v.id)} style={{ ...sBtn(D.teal, D.white), marginTop: 8, width: '100%', fontSize: 11 }}>Trigger Scrape</button>
            </div>
          );
        })}
        {vendors.length === 0 && <div style={{ color: D.muted, gridColumn: '1 / -1', textAlign: 'center', padding: 20 }}>No vendors with scraping enabled</div>}
      </div>

      <div style={{ fontSize: 15, fontWeight: 600, color: D.white, marginBottom: 12 }}>Recent Scrape Jobs</div>
      {jobs.length === 0 ? (
        <div style={{ ...sCard, textAlign: 'center', padding: 30, color: D.muted }}>No scrape jobs yet</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            {['Vendor', 'Status', 'Products', 'Updated', 'New', 'Errors', 'Duration', 'Date'].map(h => <th key={h} style={thS}>{h}</th>)}
          </tr></thead>
          <tbody>
            {jobs.map(j => (
              <tr key={j.id}>
                <td style={{ ...tdS, fontWeight: 500 }}>{j.vendor_name}</td>
                <td style={tdS}><span style={sBadge(j.status === 'completed' ? `${D.green}22` : j.status === 'failed' ? `${D.red}22` : `${D.amber}22`, j.status === 'completed' ? D.green : j.status === 'failed' ? D.red : D.amber)}>{j.status}</span></td>
                <td style={tdS}>{j.products_found}</td>
                <td style={tdS}>{j.prices_updated}</td>
                <td style={tdS}>{j.prices_new}</td>
                <td style={{ ...tdS, color: j.errors > 0 ? D.red : D.muted }}>{j.errors}</td>
                <td style={{ ...tdS, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                <td style={{ ...tdS, fontSize: 11, color: D.muted }}>{new Date(j.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
