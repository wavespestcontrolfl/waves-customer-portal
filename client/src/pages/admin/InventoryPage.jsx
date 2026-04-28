import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
// V2 token pass: teal/purple fold to zinc-900. Semantic green/amber/red preserved.
const D = { bg: '#F4F4F5', card: '#FFFFFF', border: '#E4E4E7', teal: '#18181B', green: '#15803D', amber: '#A16207', red: '#991B1B', purple: '#18181B', text: '#27272A', muted: '#71717A', white: '#FFFFFF', input: '#FFFFFF', heading: '#09090B', inputBorder: '#D4D4D8' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const sCard = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 20, marginBottom: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' };
const sBtn = (bg, color) => ({ padding: '8px 16px', background: bg, color, border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' });
const sBadge = (bg, color) => ({ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: bg, color, fontWeight: 600 });
const sInput = { padding: '8px 12px', background: D.input, border: `1px solid ${D.border}`, borderRadius: 8, color: D.text, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const thS = { fontSize: 10, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${D.border}` };
const tdS = { padding: '10px', borderBottom: `1px solid ${D.border}22`, fontSize: 13, color: D.text };

export default function InventoryPage() {
  const [tab, setTab] = useState('products');
  const [stats, setStats] = useState(null);
  const [toast, setToast] = useState('');
  const [productFilter, setProductFilter] = useState('all');
  const [showAddForm, setShowAddForm] = useState(false);

  const loadStats = () => adminFetch('/admin/inventory/stats').then(setStats).catch(() => {});
  useEffect(() => { loadStats(); }, []);
  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500); };

  const tabs = [
    { key: 'products', label: 'Products' },
    { key: 'vendors', label: 'Vendors' },
    { key: 'approvals', label: 'Approvals', badge: stats?.approvals?.pending },
    { key: 'protocols', label: 'Protocols' },
    { key: 'margins', label: 'Service Margins' },
    { key: 'scrape', label: 'Scrape Health' },
  ];

  return (
    <div style={{ maxWidth: 1300, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-0.015em', color: D.heading, margin: 0 }}>
            <span className="md:hidden" style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>Inventory</span>
            <span className="hidden md:inline">Inventory</span>
          </h1>
        </div>
        {tab === 'products' && (
          <button
            onClick={() => setShowAddForm(s => !s)}
            style={{
              padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700,
              background: '#18181B', color: '#fff', border: 'none', cursor: 'pointer',
              whiteSpace: 'nowrap', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.04em',
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            + Add Product
          </button>
        )}
      </div>

      {stats && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Products', value: stats.products?.total, color: D.heading, filter: 'all' },
            { label: 'Priced', value: stats.products?.priced, color: D.green, filter: 'priced' },
            { label: 'Needs Price', value: stats.products?.needsPrice, color: D.amber, filter: 'needs_price' },
            { label: 'Vendors', value: stats.vendors?.total, color: D.teal, action: () => setTab('vendors') },
            { label: 'Pending Approvals', value: stats.approvals?.pending, color: stats.approvals?.pending > 0 ? D.amber : D.green, action: () => setTab('approvals') },
            { label: 'Scrape Jobs', value: stats.scrapeJobs?.completed, color: D.purple, action: () => setTab('scrape') },
          ].map(s => (
            <div key={s.label} onClick={() => { if (s.action) s.action(); else if (s.filter) { setTab('products'); setProductFilter(s.filter); } }} style={{ ...sCard, flex: '1 1 120px', minWidth: 120, marginBottom: 0, textAlign: 'center', cursor: 'pointer' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 700, color: s.color }}>{s.value ?? 0}</div>
              <div style={{ fontSize: 9, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="tab-pill-scroll" style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
        <div className="tab-pill-scroll-inner" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: D.card, borderRadius: 10, padding: 4, border: `1px solid ${D.border}`, flexWrap: 'wrap' }}>
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
      </div>

      {tab === 'products' && <ProductsTab showToast={showToast} filter={productFilter} onFilterChange={setProductFilter} showAddForm={showAddForm} setShowAddForm={setShowAddForm} />}
      {tab === 'vendors' && <VendorsTab showToast={showToast} />}
      {tab === 'approvals' && <ApprovalsTab showToast={showToast} onUpdate={loadStats} />}
      {tab === 'protocols' && <ProtocolsTab showToast={showToast} />}
      {tab === 'margins' && <MarginsTab showToast={showToast} />}
      {tab === 'scrape' && <ScrapeTab showToast={showToast} />}

      <div style={{ position: 'fixed', bottom: 20, right: 20, background: D.card, border: `1px solid ${D.green}`, borderRadius: 8, padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', zIndex: 300, fontSize: 12, transform: toast ? 'translateY(0)' : 'translateY(80px)', opacity: toast ? 1 : 0, transition: 'all .3s', pointerEvents: 'none' }}>
        <span style={{ color: D.green }}>✓</span><span style={{ color: D.text }}>{toast}</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PRODUCTS TAB — with inline editing
// ══════════════════════════════════════════════════════════════
function ProductsTab({ showToast, filter = 'all', onFilterChange, showAddForm, setShowAddForm }) {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [vendors, setVendors] = useState([]);
  const [newProduct, setNewProduct] = useState({ name: '', category: '', activeIngredient: '', moaGroup: '', defaultUnit: 'oz' });
  const [deleting, setDeleting] = useState(null);
  const [page, setPage] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const PER_PAGE = 50;

  const load = useCallback(async () => {
    const needsPricingParam = filter === 'needs_price' ? '&needsPricing=true' : filter === 'priced' ? '&needsPricing=false' : '';
    const [pData, vData] = await Promise.all([
      adminFetch(`/admin/inventory?search=${encodeURIComponent(search)}&category=${encodeURIComponent(catFilter)}&limit=${PER_PAGE}&page=${page}${needsPricingParam}`),
      adminFetch('/admin/inventory/vendors'),
    ]);
    setProducts(pData.products || []);
    setCategories(pData.categories || []);
    setTotalProducts(pData.total || 0);
    setVendors(vData.vendors || []);
    setLoading(false);
  }, [search, catFilter, page, filter]);

  useEffect(() => { load(); }, [load]);

  const savePrice = async (productId, vendorId, price, quantity) => {
    try {
      await adminFetch(`/admin/inventory/${productId}/pricing`, { method: 'PUT', body: JSON.stringify({ vendorId, price: parseFloat(price), quantity }) });
      showToast('Price saved'); load();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  const startEdit = (p, e) => {
    e && e.stopPropagation();
    setEditing(p.id);
    setEditForm({ name: p.name || '', category: p.category || '', activeIngredient: p.activeIngredient || '', moaGroup: p.moaGroup || '', containerSize: p.containerSize || '', formulation: p.formulation || '', sku: p.sku || '' });
  };

  const saveEdit = async (id) => {
    try {
      await adminFetch(`/admin/inventory/${id}`, { method: 'PUT', body: JSON.stringify(editForm) });
      showToast('Product updated'); setEditing(null); load();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading products...</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[{ key: 'all', label: 'All Products' }, { key: 'priced', label: 'Priced' }, { key: 'needs_price', label: 'Needs Price' }].map(f => (
          <button key={f.key} onClick={() => { onFilterChange?.(f.key); setPage(1); }} style={{ padding: '6px 14px', borderRadius: 20, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', background: filter === f.key ? D.teal : D.card, color: filter === f.key ? D.white : D.muted }}>{f.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search products..." style={{ ...sInput, flex: 1, minWidth: 200 }} />
        <select value={catFilter} onChange={e => { setCatFilter(e.target.value); setPage(1); }} style={{ ...sInput, cursor: 'pointer', minWidth: 150 }}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c.name} value={c.name}>{c.name} ({c.count})</option>)}
        </select>
      </div>

      {showAddForm && (
        <div style={{ background: D.card, borderRadius: 10, padding: 16, border: `1px solid ${D.green}44`, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: D.heading, marginBottom: 10 }}>New Product</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
            <input value={newProduct.name} onChange={e => setNewProduct(p => ({ ...p, name: e.target.value }))} placeholder="Product name *" style={sInput} />
            <input value={newProduct.category} onChange={e => setNewProduct(p => ({ ...p, category: e.target.value }))} placeholder="Category" style={sInput} />
            <input value={newProduct.activeIngredient} onChange={e => setNewProduct(p => ({ ...p, activeIngredient: e.target.value }))} placeholder="Active ingredient" style={sInput} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <input value={newProduct.moaGroup} onChange={e => setNewProduct(p => ({ ...p, moaGroup: e.target.value }))} placeholder="MOA/FRAC group" style={sInput} />
            <select value={newProduct.defaultUnit} onChange={e => setNewProduct(p => ({ ...p, defaultUnit: e.target.value }))} style={sInput}>
              <option value="oz">oz</option><option value="ml">ml</option><option value="gal">gal</option><option value="lb">lb</option><option value="g">g</option><option value="each">each</option>
            </select>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={async () => {
                if (!newProduct.name.trim()) { showToast('Product name required'); return; }
                try { await adminFetch('/admin/inventory', { method: 'POST', body: JSON.stringify(newProduct) }); showToast('Product added'); setNewProduct({ name: '', category: '', activeIngredient: '', moaGroup: '', defaultUnit: 'oz' }); setShowAddForm(false); load(); } catch (e) { showToast('Failed: ' + e.message); }
              }} style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: D.green, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Save</button>
              <button onClick={() => setShowAddForm(false)} style={{ padding: '10px 14px', borderRadius: 8, border: `1px solid ${D.border}`, background: 'none', color: D.muted, fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          {['Product', 'Category', 'Active Ingredient', 'MOA', 'Size', 'Best Price', 'Vendor', 'Status', ''].map(h => <th key={h} style={thS}>{h}</th>)}
        </tr></thead>
        <tbody>
          {products.map(p => {
            const isEditing = editing === p.id;
            const isExpanded = expanded === p.id && !isEditing;
            return [
              <tr key={p.id} onClick={() => !isEditing && setExpanded(expanded === p.id ? null : p.id)} style={{ cursor: isEditing ? 'default' : 'pointer', background: isEditing ? `${D.teal}10` : isExpanded ? `${D.teal}08` : 'transparent' }}>
                <td style={{ ...tdS, fontWeight: 600, color: D.heading }}>{isEditing ? <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} style={{ ...sInput, width: '100%', fontWeight: 600 }} onClick={e => e.stopPropagation()} /> : p.name}</td>
                <td style={tdS}>{isEditing ? <input value={editForm.category} onChange={e => setEditForm(f => ({ ...f, category: e.target.value }))} style={{ ...sInput, width: 100 }} onClick={e => e.stopPropagation()} /> : <span style={sBadge(`${D.teal}22`, D.teal)}>{p.category}</span>}</td>
                <td style={{ ...tdS, color: D.muted, fontSize: 12 }}>{isEditing ? <input value={editForm.activeIngredient} onChange={e => setEditForm(f => ({ ...f, activeIngredient: e.target.value }))} style={{ ...sInput, width: '100%' }} onClick={e => e.stopPropagation()} /> : (p.activeIngredient || '—')}</td>
                <td style={{ ...tdS, color: D.muted, fontSize: 11 }}>{isEditing ? <input value={editForm.moaGroup} onChange={e => setEditForm(f => ({ ...f, moaGroup: e.target.value }))} style={{ ...sInput, width: 80 }} onClick={e => e.stopPropagation()} /> : (p.moaGroup || '—')}</td>
                <td style={{ ...tdS, fontSize: 12 }}>{isEditing ? <input value={editForm.containerSize} onChange={e => setEditForm(f => ({ ...f, containerSize: e.target.value }))} style={{ ...sInput, width: 80 }} onClick={e => e.stopPropagation()} /> : (p.containerSize || '—')}</td>
                <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace", color: p.bestPrice ? D.green : D.muted }}>{p.bestPrice ? `$${p.bestPrice.toFixed(2)}` : '—'}</td>
                <td style={{ ...tdS, fontSize: 12 }}>{p.bestVendor || '—'}</td>
                <td style={tdS}>{p.needsPricing ? <span style={sBadge(`${D.amber}22`, D.amber)}>Needs Price</span> : <span style={sBadge(`${D.green}22`, D.green)}>Priced</span>}</td>
                <td style={{ ...tdS, width: 90 }}>
                  <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                    {isEditing ? (
                      <>
                        <button onClick={() => saveEdit(p.id)} style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, border: 'none', background: D.green, color: '#fff', cursor: 'pointer', fontWeight: 600 }}>Save</button>
                        <button onClick={() => setEditing(null)} style={{ fontSize: 10, padding: '3px 6px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'none', color: D.muted, cursor: 'pointer' }}>×</button>
                      </>
                    ) : (
                      <>
                        <button onClick={(e) => startEdit(p, e)} style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'none', color: D.teal, cursor: 'pointer' }} title="Edit">✎</button>
                        {deleting === p.id ? (
                          <>
                            <button onClick={async () => { try { await adminFetch(`/admin/inventory/${p.id}`, { method: 'DELETE' }); showToast('Deleted'); load(); } catch { showToast('Delete failed'); } setDeleting(null); }} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: 'none', background: D.red, color: '#fff', cursor: 'pointer' }}>Yes</button>
                            <button onClick={() => setDeleting(null)} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'none', color: D.muted, cursor: 'pointer' }}>No</button>
                          </>
                        ) : (
                          <button onClick={() => setDeleting(p.id)} style={{ fontSize: 12, background: 'none', border: 'none', color: D.muted, cursor: 'pointer', padding: 4 }}>×</button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>,
              isExpanded && (
                <tr key={`${p.id}-exp`}><td colSpan={9} style={{ padding: '0 10px 16px', background: `${D.teal}05` }}>
                  <ExpandedProduct product={p} vendors={vendors} onSave={savePrice} />
                </td></tr>
              ),
            ];
          })}
        </tbody>
      </table>
      </div>
      {products.length === 0 && <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No products found</div>}
      {totalProducts > PER_PAGE && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0' }}>
          <div style={{ fontSize: 12, color: D.muted }}>
            Showing {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, totalProducts)} of {totalProducts} products
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} style={{ ...sBtn(page <= 1 ? D.card : D.teal, page <= 1 ? D.muted : D.white), opacity: page <= 1 ? 0.5 : 1 }}>← Prev</button>
            <span style={{ fontSize: 13, color: D.text, padding: '8px 12px', fontFamily: "'JetBrains Mono', monospace" }}>{page} / {Math.ceil(totalProducts / PER_PAGE)}</span>
            <button disabled={page >= Math.ceil(totalProducts / PER_PAGE)} onClick={() => setPage(p => p + 1)} style={{ ...sBtn(page >= Math.ceil(totalProducts / PER_PAGE) ? D.card : D.teal, page >= Math.ceil(totalProducts / PER_PAGE) ? D.muted : D.white), opacity: page >= Math.ceil(totalProducts / PER_PAGE) ? 0.5 : 1 }}>Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpandedProduct({ product, vendors, onSave }) {
  const [vendorId, setVendorId] = useState(vendors[0]?.id || '');
  const [price, setPrice] = useState('');
  const [qty, setQty] = useState('');

  return (
    <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', gap: 16, marginBottom: 12, flexWrap: 'wrap', fontSize: 12 }}>
        {product.formulation && <span style={{ color: D.muted }}>Formulation: <span style={{ color: D.text }}>{product.formulation}</span></span>}
        {product.unitSizeOz && <span style={{ color: D.muted }}>Size (oz): <span style={{ color: D.text }}>{product.unitSizeOz}</span></span>}
        {product.sku && <span style={{ color: D.muted }}>SKU: <span style={{ color: D.text }}>{product.sku}</span></span>}
      </div>
      {product.vendorPricing.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Vendor Prices</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {product.vendorPricing.map((vp, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 10px', background: D.input, borderRadius: 6, fontSize: 12 }}>
                <span style={{ color: D.heading, fontWeight: 600, minWidth: 140 }}>{vp.vendorName}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: vp.isBest ? D.green : D.text }}>${vp.price.toFixed(2)}</span>
                {vp.quantity && <span style={{ color: D.muted }}>{vp.quantity}</span>}
                {vp.pricePerOz && <span style={{ color: D.muted, fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>${vp.pricePerOz}/oz</span>}
                {vp.isBest && <span style={sBadge(`${D.green}22`, D.green)}>Best</span>}
                {vp.url && <a href={vp.url} target="_blank" rel="noopener noreferrer" style={{ color: D.teal, fontSize: 11 }}>↗</a>}
                {vp.lastChecked && <span style={{ color: D.muted, fontSize: 10 }}>{new Date(vp.lastChecked).toLocaleDateString()}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Vendor</label>
          <select value={vendorId} onChange={e => setVendorId(e.target.value)} style={{ ...sInput, width: 160 }}>{vendors.filter(v => v.active).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></div>
        <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Price</label>
          <input value={price} onChange={e => setPrice(e.target.value)} type="number" step="0.01" placeholder="0.00" style={{ ...sInput, width: 100 }} /></div>
        <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Quantity</label>
          <input value={qty} onChange={e => setQty(e.target.value)} placeholder="e.g. 32 oz" style={{ ...sInput, width: 120 }} /></div>
        <button onClick={() => { if (price) { onSave(product.id, vendorId, price, qty); setPrice(''); setQty(''); } }} style={sBtn(D.teal, D.white)}>Add Price</button>
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
  const load = async () => { const d = await adminFetch('/admin/inventory/vendors'); setVendors(d.vendors || []); setLoading(false); };
  useEffect(() => { load(); }, []);
  const save = async (id, form) => { try { await adminFetch(`/admin/inventory/vendors/${id}`, { method: 'PUT', body: JSON.stringify(form) }); showToast('Vendor updated'); setEditing(null); load(); } catch (e) { showToast('Failed: ' + e.message); } };
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading vendors...</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
      {vendors.map(v => (
        <div key={v.id} style={{ ...sCard, marginBottom: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
            <div><div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{v.name}</div><div style={{ fontSize: 11, color: D.muted }}>{v.type}</div></div>
            <div style={{ display: 'flex', gap: 4 }}>
              {v.scrapingEnabled && <span style={sBadge(`${D.green}22`, D.green)}>Scrape</span>}
              {v.hasCredentials && <span style={sBadge(`${D.teal}22`, D.teal)}>Login</span>}
              {!v.active && <span style={sBadge(`${D.red}22`, D.red)}>Inactive</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: D.muted, marginBottom: 8 }}><span>{v.productCount} products</span><span>{v.bestPriceCount} best prices</span></div>
          {v.website && <a href={v.website} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: D.teal, display: 'block', marginTop: 4 }}>{v.website}</a>}
          {editing === v.id ? <VendorEditForm vendor={v} onSave={save} onCancel={() => setEditing(null)} /> : <button onClick={() => setEditing(v.id)} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}`, marginTop: 8, width: '100%', fontSize: 11 }}>Edit Credentials</button>}
        </div>
      ))}
    </div>
  );
}

function VendorEditForm({ vendor, onSave, onCancel }) {
  const [form, setForm] = useState({ loginUsername: vendor.loginUsername || '', loginEmail: vendor.loginEmail || '', loginPassword: '', accountNumber: vendor.accountNumber || '', loginUrl: vendor.loginUrl || '' });
  return (
    <div style={{ marginTop: 8, padding: 12, background: D.input, borderRadius: 8 }}>
      {[{ key: 'loginUsername', label: 'Username' }, { key: 'loginEmail', label: 'Email' }, { key: 'loginPassword', label: 'Password', type: 'password' }, { key: 'accountNumber', label: 'Account #' }, { key: 'loginUrl', label: 'Login URL' }].map(f => (
        <div key={f.key} style={{ marginBottom: 6 }}><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>{f.label}</label>
          <input value={form[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} type={f.type || 'text'} placeholder={f.label} style={{ ...sInput, width: '100%' }} /></div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}><button onClick={() => onSave(vendor.id, form)} style={sBtn(D.teal, D.white)}>Save</button><button onClick={onCancel} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}` }}>Cancel</button></div>
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
  const handleAction = async (id, action) => { try { await adminFetch(`/admin/inventory/approvals/${id}/${action}`, { method: 'POST' }); showToast(action === 'approve' ? 'Approved' : 'Rejected'); load(); onUpdate(); } catch (e) { showToast(`Failed: ${e.message}`); } };
  const handleBulk = async (action) => { try { await adminFetch('/admin/inventory/approvals/bulk', { method: 'POST', body: JSON.stringify({ ids: [...selected], action }) }); showToast(`${action === 'approve' ? 'Approved' : 'Rejected'} ${selected.size} items`); setSelected(new Set()); load(); onUpdate(); } catch (e) { showToast(`Failed: ${e.message}`); } };
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
        <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}><div style={{ fontSize: 24, marginBottom: 8 }}>✓</div>No pending approvals</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {approvals.map(a => {
            const pct = a.price_change_pct || (a.old_price ? ((a.new_price - a.old_price) / a.old_price * 100).toFixed(1) : null);
            const isUp = pct > 0;
            return (
              <div key={a.id} style={{ ...sCard, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
                <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} style={{ accentColor: D.teal, cursor: 'pointer' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: D.heading }}>{a.product_name}</div>
                  <div style={{ fontSize: 12, color: D.muted }}>{a.vendor_name} · {a.category}</div>
                  {a.notes && <div style={{ fontSize: 11, color: D.purple, marginTop: 2 }}>{a.notes}</div>}
                </div>
                <div style={{ textAlign: 'center', minWidth: 80 }}>
                  {a.old_price && <div style={{ fontSize: 12, color: D.muted, textDecoration: 'line-through' }}>${parseFloat(a.old_price).toFixed(2)}</div>}
                  <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", color: D.heading }}>${parseFloat(a.new_price).toFixed(2)}</div>
                </div>
                {pct !== null && <span style={sBadge(isUp ? `${D.red}22` : `${D.green}22`, isUp ? D.red : D.green)}>{isUp ? '+' : ''}{pct}%</span>}
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
// PROTOCOLS TAB
// ══════════════════════════════════════════════════════════════
function ProtocolsTab({ showToast }) {
  const [services, setServices] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingRow, setEditingRow] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [showAdd, setShowAdd] = useState(null);
  const [newRow, setNewRow] = useState({ productId: '', usageAmount: '', usageUnit: 'oz', usagePer1000sf: '', isPrimary: false, notes: '' });
  const [newServiceType, setNewServiceType] = useState('');
  const [showNewService, setShowNewService] = useState(false);

  const load = async () => {
    const [sData, pData] = await Promise.all([adminFetch('/admin/inventory/service-usage'), adminFetch('/admin/inventory?limit=200')]);
    setServices(sData.services || []); setProducts(pData.products || []); setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const startEdit = (row) => { setEditingRow(row.id); setEditForm({ usageAmount: row.usageAmount || '', usageUnit: row.usageUnit || 'oz', usagePer1000sf: row.usagePer1000sf || '', isPrimary: row.isPrimary, notes: row.notes || '' }); };
  const saveEdit = async (id) => { try { await adminFetch(`/admin/inventory/service-usage/${id}`, { method: 'PUT', body: JSON.stringify(editForm) }); showToast('Protocol updated'); setEditingRow(null); load(); } catch (e) { showToast(`Failed: ${e.message}`); } };
  const deleteRow = async (id) => { try { await adminFetch(`/admin/inventory/service-usage/${id}`, { method: 'DELETE' }); showToast('Removed'); load(); } catch (e) { showToast(`Failed: ${e.message}`); } };
  const addRow = async (serviceType) => {
    if (!newRow.productId) { showToast('Select a product'); return; }
    try { await adminFetch('/admin/inventory/service-usage', { method: 'POST', body: JSON.stringify({ serviceType, productId: newRow.productId, usageAmount: parseFloat(newRow.usageAmount) || 0, usageUnit: newRow.usageUnit, usagePer1000sf: parseFloat(newRow.usagePer1000sf) || null, isPrimary: newRow.isPrimary, notes: newRow.notes }) });
      showToast('Product added to protocol'); setShowAdd(null); setNewRow({ productId: '', usageAmount: '', usageUnit: 'oz', usagePer1000sf: '', isPrimary: false, notes: '' }); load();
    } catch (e) { showToast(`Failed: ${e.message}`); }
  };

  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading protocols...</div>;

  const unitOpts = ['oz','ml','gal','lb','g','packets','tube','station','blocks','traps','each'];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div><div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>Treatment Protocols by Service Line</div>
          <div style={{ fontSize: 12, color: D.muted }}>Define which products each service uses, at what rates — drives COGS calculations</div></div>
        <button onClick={() => setShowNewService(!showNewService)} style={sBtn(D.green, D.white)}>+ New Service Type</button>
      </div>

      {showNewService && (
        <div style={{ ...sCard, display: 'flex', gap: 8, alignItems: 'center', border: `1px solid ${D.green}44` }}>
          <input value={newServiceType} onChange={e => setNewServiceType(e.target.value)} placeholder="Service type (e.g. Mole Trapping)" style={{ ...sInput, flex: 1 }} />
          <button onClick={() => { if (newServiceType.trim()) { setShowAdd(newServiceType.trim()); setShowNewService(false); } }} style={sBtn(D.green, D.white)}>Create</button>
          <button onClick={() => setShowNewService(false)} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}` }}>Cancel</button>
        </div>
      )}

      {showAdd && !services.find(s => s.serviceType === showAdd) && (
        <div style={{ ...sCard, border: `1px solid ${D.teal}44` }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>{showAdd}</div>
          <AddProtocolRow products={products} newRow={newRow} setNewRow={setNewRow} unitOpts={unitOpts} onAdd={() => addRow(showAdd)} onCancel={() => setShowAdd(null)} />
        </div>
      )}

      {services.length === 0 && !showAdd && <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No protocols defined yet.</div>}

      {services.map(svc => (
        <div key={svc.serviceType} style={{ ...sCard }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{svc.serviceType}</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700, color: D.green }}>${svc.totalCost.toFixed(2)}/app</div>
              <button onClick={() => setShowAdd(showAdd === svc.serviceType ? null : svc.serviceType)} style={{ ...sBtn(D.teal, D.white), fontSize: 11, padding: '6px 12px' }}>+ Product</button>
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Product', 'Usage', 'Per 1000sf', 'Best Price', 'Cost/App', 'Primary', 'Notes', ''].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
            <tbody>
              {svc.products.map(p => editingRow === p.id ? (
                <tr key={p.id} style={{ background: `${D.teal}10` }}>
                  <td style={{ ...tdS, fontWeight: 500 }}>{p.productName}</td>
                  <td style={tdS}><div style={{ display: 'flex', gap: 4 }}><input value={editForm.usageAmount} onChange={e => setEditForm(f => ({ ...f, usageAmount: e.target.value }))} type="number" step="0.01" style={{ ...sInput, width: 60 }} /><select value={editForm.usageUnit} onChange={e => setEditForm(f => ({ ...f, usageUnit: e.target.value }))} style={{ ...sInput, width: 70 }}>{unitOpts.map(u => <option key={u} value={u}>{u}</option>)}</select></div></td>
                  <td style={tdS}><input value={editForm.usagePer1000sf} onChange={e => setEditForm(f => ({ ...f, usagePer1000sf: e.target.value }))} type="number" step="0.001" placeholder="—" style={{ ...sInput, width: 70 }} /></td>
                  <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace" }}>{p.bestPrice ? `$${parseFloat(p.bestPrice).toFixed(2)}` : '—'}</td>
                  <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace", color: D.green }}>{p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : '—'}</td>
                  <td style={tdS}><input type="checkbox" checked={editForm.isPrimary} onChange={e => setEditForm(f => ({ ...f, isPrimary: e.target.checked }))} style={{ accentColor: D.teal }} /></td>
                  <td style={tdS}><input value={editForm.notes} onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} style={{ ...sInput, width: '100%' }} /></td>
                  <td style={{ ...tdS, width: 80 }}><div style={{ display: 'flex', gap: 4 }}><button onClick={() => saveEdit(p.id)} style={{ fontSize: 10, padding: '3px 6px', borderRadius: 4, border: 'none', background: D.green, color: '#fff', cursor: 'pointer' }}>Save</button><button onClick={() => setEditingRow(null)} style={{ fontSize: 10, padding: '3px 6px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'none', color: D.muted, cursor: 'pointer' }}>×</button></div></td>
                </tr>
              ) : (
                <tr key={p.id}>
                  <td style={{ ...tdS, fontWeight: 500 }}>{p.productName} {p.isPrimary && <span style={sBadge(`${D.teal}22`, D.teal)}>Primary</span>}</td>
                  <td style={{ ...tdS, fontSize: 12 }}>{p.usageAmount} {p.usageUnit}</td>
                  <td style={{ ...tdS, fontSize: 12 }}>{p.usagePer1000sf || '—'}</td>
                  <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace" }}>{p.bestPrice ? `$${parseFloat(p.bestPrice).toFixed(2)}` : '—'}</td>
                  <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace", color: D.green }}>{p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : '—'}</td>
                  <td style={{ ...tdS, fontSize: 11 }}>{p.isPrimary ? '✓' : ''}</td>
                  <td style={{ ...tdS, fontSize: 11, color: D.muted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.notes || '—'}</td>
                  <td style={{ ...tdS, width: 80 }}><div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => startEdit(p)} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: `1px solid ${D.border}`, background: 'none', color: D.teal, cursor: 'pointer' }}>✎</button>
                    <button onClick={() => deleteRow(p.id)} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: 'none', background: `${D.red}22`, color: D.red, cursor: 'pointer' }}>×</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
          {showAdd === svc.serviceType && (
            <div style={{ marginTop: 8, padding: 12, background: D.input, borderRadius: 8 }}>
              <AddProtocolRow products={products} newRow={newRow} setNewRow={setNewRow} unitOpts={unitOpts} onAdd={() => addRow(svc.serviceType)} onCancel={() => setShowAdd(null)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function AddProtocolRow({ products, newRow, setNewRow, unitOpts, onAdd, onCancel }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Product</label>
        <select value={newRow.productId} onChange={e => setNewRow(r => ({ ...r, productId: e.target.value }))} style={{ ...sInput, width: 200 }}><option value="">Select...</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
      <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Amount</label>
        <input value={newRow.usageAmount} onChange={e => setNewRow(r => ({ ...r, usageAmount: e.target.value }))} type="number" step="0.01" style={{ ...sInput, width: 70 }} /></div>
      <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Unit</label>
        <select value={newRow.usageUnit} onChange={e => setNewRow(r => ({ ...r, usageUnit: e.target.value }))} style={{ ...sInput, width: 80 }}>{unitOpts.map(u => <option key={u} value={u}>{u}</option>)}</select></div>
      <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Per 1000sf</label>
        <input value={newRow.usagePer1000sf} onChange={e => setNewRow(r => ({ ...r, usagePer1000sf: e.target.value }))} type="number" step="0.001" placeholder="—" style={{ ...sInput, width: 70 }} /></div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><input type="checkbox" checked={newRow.isPrimary} onChange={e => setNewRow(r => ({ ...r, isPrimary: e.target.checked }))} style={{ accentColor: D.teal }} /><label style={{ fontSize: 10, color: D.muted }}>Primary</label></div>
      <div><label style={{ fontSize: 10, color: D.muted, display: 'block', marginBottom: 2 }}>Notes</label>
        <input value={newRow.notes} onChange={e => setNewRow(r => ({ ...r, notes: e.target.value }))} placeholder="Usage notes..." style={{ ...sInput, width: 150 }} /></div>
      <button onClick={onAdd} style={sBtn(D.green, D.white)}>Add</button>
      <button onClick={onCancel} style={{ ...sBtn('transparent', D.muted), border: `1px solid ${D.border}` }}>Cancel</button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// SERVICE MARGINS TAB
// ══════════════════════════════════════════════════════════════
function MarginsTab({ showToast }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { adminFetch('/admin/inventory/service-usage').then(d => { setServices(d.services || []); setLoading(false); }).catch(() => setLoading(false)); }, []);
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading service margins...</div>;
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 16 }}>COGS by Service Line</div>
      {services.length === 0 ? <div style={{ ...sCard, textAlign: 'center', padding: 40, color: D.muted }}>No service product mappings yet.</div> : services.map(svc => (
        <div key={svc.serviceType} style={{ ...sCard }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: D.heading }}>{svc.serviceType}</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 16, fontWeight: 700, color: D.green }}>${svc.totalCost.toFixed(2)}/app</div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Product', 'Usage', 'Per 1000sf', 'Best Price', 'Cost/App'].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
            <tbody>{svc.products.map(p => (
              <tr key={p.id}>
                <td style={{ ...tdS, fontWeight: 500 }}>{p.productName} {p.isPrimary && <span style={sBadge(`${D.teal}22`, D.teal)}>Primary</span>}</td>
                <td style={{ ...tdS, fontSize: 12 }}>{p.usageAmount} {p.usageUnit}</td>
                <td style={{ ...tdS, fontSize: 12 }}>{p.usagePer1000sf || '—'}</td>
                <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace" }}>{p.bestPrice ? `$${parseFloat(p.bestPrice).toFixed(2)}` : '—'}</td>
                <td style={{ ...tdS, fontFamily: "'JetBrains Mono', monospace", color: D.green }}>{p.costPerApp ? `$${p.costPerApp.toFixed(2)}` : '—'}</td>
              </tr>
            ))}</tbody>
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
  const load = async () => { const [vData, jData] = await Promise.all([adminFetch('/admin/inventory/vendors'), adminFetch('/admin/inventory/scrape-jobs')]); setVendors((vData.vendors || []).filter(v => v.scrapingEnabled)); setJobs(jData.jobs || []); setLoading(false); };
  useEffect(() => { load(); }, []);
  const triggerScrape = async (vendorId) => { try { const r = await adminFetch(`/admin/inventory/scrape-jobs/${vendorId}/trigger`, { method: 'POST' }); showToast(r.message || 'Scrape triggered'); load(); } catch (e) { showToast(`Failed: ${e.message}`); } };
  if (loading) return <div style={{ color: D.muted, padding: 40, textAlign: 'center' }}>Loading scrape data...</div>;
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 16 }}>Vendor Scrape Status</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, marginBottom: 24 }}>
        {vendors.map(v => {
          const sc = v.lastScrapeStatus === 'completed' ? D.green : v.lastScrapeStatus === 'running' ? D.amber : v.lastScrapeStatus === 'failed' ? D.red : D.muted;
          return (<div key={v.id} style={{ ...sCard, marginBottom: 0, textAlign: 'center' }}><div style={{ fontSize: 14, fontWeight: 600, color: D.heading, marginBottom: 4 }}>{v.name}</div><div style={{ fontSize: 11, color: D.muted, marginBottom: 8 }}>{v.productCount} products</div><span style={sBadge(`${sc}22`, sc)}>{v.lastScrapeStatus || 'never'}</span><button onClick={() => triggerScrape(v.id)} style={{ ...sBtn(D.teal, D.white), marginTop: 8, width: '100%', fontSize: 11 }}>Trigger Scrape</button></div>);
        })}
        {!vendors.length && <div style={{ color: D.muted, gridColumn: '1 / -1', textAlign: 'center', padding: 20 }}>No vendors with scraping enabled</div>}
      </div>
      <div style={{ fontSize: 15, fontWeight: 600, color: D.heading, marginBottom: 12 }}>Recent Scrape Jobs</div>
      {!jobs.length ? <div style={{ ...sCard, textAlign: 'center', padding: 30, color: D.muted }}>No scrape jobs yet</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Vendor', 'Status', 'Products', 'Updated', 'New', 'Errors', 'Duration', 'Date'].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
          <tbody>{jobs.map(j => (
            <tr key={j.id}>
              <td style={{ ...tdS, fontWeight: 500 }}>{j.vendor_name}</td>
              <td style={tdS}><span style={sBadge(j.status === 'completed' ? `${D.green}22` : j.status === 'failed' ? `${D.red}22` : `${D.amber}22`, j.status === 'completed' ? D.green : j.status === 'failed' ? D.red : D.amber)}>{j.status}</span></td>
              <td style={tdS}>{j.products_found}</td><td style={tdS}>{j.prices_updated}</td><td style={tdS}>{j.prices_new}</td>
              <td style={{ ...tdS, color: j.errors > 0 ? D.red : D.muted }}>{j.errors}</td>
              <td style={{ ...tdS, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
              <td style={{ ...tdS, fontSize: 11, color: D.muted }}>{new Date(j.created_at).toLocaleString()}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
