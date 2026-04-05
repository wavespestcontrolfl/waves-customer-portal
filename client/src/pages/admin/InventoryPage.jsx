import { useState, useEffect } from 'react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';
const D = { bg: '#0f1923', card: '#1e293b', border: '#334155', teal: '#0ea5e9', green: '#10b981', amber: '#f59e0b', red: '#ef4444', text: '#e2e8f0', muted: '#94a3b8', white: '#fff' };

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`, 'Content-Type': 'application/json' },
    ...options,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const CATEGORY_COLORS = {
  herbicide: D.green,
  insecticide: D.teal,
  fungicide: '#a855f7',
  fertilizer: D.amber,
  other: D.muted,
};

function CategoryBadge({ category }) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.other;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
      background: `${color}22`, color, textTransform: 'capitalize', letterSpacing: 0.5,
    }}>
      {category}
    </span>
  );
}

function StatCard({ label, value, color, highlight }) {
  return (
    <div style={{
      background: D.card, border: `1px solid ${highlight ? color : D.border}`, borderRadius: 12,
      padding: '20px 24px', flex: '1 1 0', minWidth: 160,
    }}>
      <div style={{ color: D.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 28, fontWeight: 700, color: color || D.white }}>{value}</div>
    </div>
  );
}

function VendorPriceRow({ vp }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8,
      background: vp.isBest ? `${D.green}15` : 'transparent',
      border: vp.isBest ? `1px solid ${D.green}44` : `1px solid ${D.border}`,
      marginBottom: 4,
    }}>
      <span style={{ fontSize: 13, color: D.white, fontWeight: 500, minWidth: 120 }}>{vp.vendorName}</span>
      <span style={{
        fontFamily: 'JetBrains Mono, monospace', fontSize: 14, fontWeight: 700,
        color: vp.isBest ? D.green : D.text, minWidth: 70,
      }}>
        ${Number(vp.price || 0).toFixed(2)}
      </span>
      <span style={{ fontSize: 12, color: D.muted }}>{vp.quantity}</span>
      {vp.isBest && <span style={{ fontSize: 10, color: D.green, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>Best</span>}
      <div style={{ flex: 1 }} />
      {vp.url && (
        <a href={vp.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: D.teal, textDecoration: 'none' }}>
          View
        </a>
      )}
    </div>
  );
}

function ProductRow({ product }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', cursor: 'pointer',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = '#253347'}
        onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
      >
        <span style={{ fontSize: 12, color: D.muted, transition: 'transform 0.2s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
          ▶
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: D.white }}>{product.name}</span>
            <CategoryBadge category={product.category} />
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
            <span style={{ fontSize: 12, color: D.muted }}>{product.activeIngredient}</span>
            {product.moaGroup && <span style={{ fontSize: 11, color: D.border }}>|</span>}
            {product.moaGroup && <span style={{ fontSize: 11, color: D.muted }}>{product.moaGroup}</span>}
            {product.containerSize && <span style={{ fontSize: 11, color: D.border }}>|</span>}
            {product.containerSize && <span style={{ fontSize: 11, color: D.muted }}>{product.containerSize}</span>}
          </div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 140 }}>
          {product.needsPricing ? (
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13, color: D.amber, fontWeight: 600 }}>Needs pricing</span>
          ) : (
            <>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 15, color: D.green, fontWeight: 700 }}>
                ${Number(product.bestPrice || 0).toFixed(2)}
              </span>
              <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>{product.bestVendor}</div>
            </>
          )}
        </div>
      </div>
      {expanded && product.vendorPricing && product.vendorPricing.length > 0 && (
        <div style={{ padding: '0 18px 14px 42px', borderTop: `1px solid ${D.border}` }}>
          <div style={{ fontSize: 11, color: D.muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, marginTop: 12 }}>
            Vendor Pricing Comparison
          </div>
          {product.vendorPricing.map((vp, i) => <VendorPriceRow key={i} vp={vp} />)}
        </div>
      )}
      {expanded && (!product.vendorPricing || product.vendorPricing.length === 0) && (
        <div style={{ padding: '12px 18px 14px 42px', borderTop: `1px solid ${D.border}`, color: D.muted, fontSize: 13 }}>
          No vendor pricing data available.
        </div>
      )}
    </div>
  );
}

function VendorCard({ vendor }) {
  return (
    <div style={{
      background: D.card, border: `1px solid ${D.border}`, borderRadius: 10, padding: '12px 14px', marginBottom: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: vendor.isActive !== false ? D.green : D.muted,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: D.white, flex: 1 }}>{vendor.name}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        {vendor.type && (
          <span style={{
            display: 'inline-block', padding: '1px 8px', borderRadius: 9999, fontSize: 10, fontWeight: 600,
            background: `${D.teal}22`, color: D.teal, textTransform: 'capitalize',
          }}>
            {vendor.type}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: D.muted }}>
        {vendor.productCount != null && <span>{vendor.productCount} products</span>}
        {vendor.bestPriceCount != null && (
          <span style={{ color: D.green }}>{vendor.bestPriceCount} best prices</span>
        )}
      </div>
      {vendor.website && (
        <a href={vendor.website} target="_blank" rel="noopener noreferrer"
          style={{ fontSize: 11, color: D.teal, textDecoration: 'none', marginTop: 4, display: 'inline-block' }}>
          {vendor.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </a>
      )}
    </div>
  );
}

function PriceResearchQueue({ products, vendors }) {
  const needsPricing = products
    .filter(p => p.needsPricing)
    .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));

  if (needsPricing.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: D.muted, fontSize: 14 }}>
        All products are priced. Nice work!
      </div>
    );
  }

  const vendorWebsites = {};
  (vendors || []).forEach(v => {
    if (v.website) vendorWebsites[v.name] = v.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
  });

  const topVendors = (vendors || []).filter(v => v.website).slice(0, 6);

  return (
    <div>
      <div style={{ fontSize: 12, color: D.muted, marginBottom: 16 }}>
        {needsPricing.length} product{needsPricing.length !== 1 ? 's' : ''} need pricing research
      </div>
      {needsPricing.map(product => (
        <div key={product.id} style={{
          background: D.card, border: `1px solid ${D.amber}33`, borderRadius: 10, padding: '14px 18px', marginBottom: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: D.white }}>{product.name}</span>
            <CategoryBadge category={product.category} />
          </div>
          <div style={{ fontSize: 12, color: D.muted, marginBottom: 10 }}>
            {product.activeIngredient}{product.containerSize ? ` - ${product.containerSize}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {topVendors.map(v => {
              const domain = v.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
              const url = `https://www.google.com/search?q=site:${encodeURIComponent(domain)}+%22${encodeURIComponent(product.name)}%22`;
              return (
                <a key={v.name} href={url} target="_blank" rel="noopener noreferrer" style={{
                  display: 'inline-block', padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                  background: `${D.teal}18`, color: D.teal, textDecoration: 'none', border: `1px solid ${D.teal}33`,
                  transition: 'background 0.15s',
                }}
                  onMouseEnter={e => e.currentTarget.style.background = `${D.teal}33`}
                  onMouseLeave={e => e.currentTarget.style.background = `${D.teal}18`}
                >
                  Search {v.name}
                </a>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AdminInventoryPage() {
  const [products, setProducts] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [stats, setStats] = useState(null);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // filters
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [needsPricingOnly, setNeedsPricingOnly] = useState(false);
  const [sortBy, setSortBy] = useState('name');

  // tabs
  const [activeTab, setActiveTab] = useState('products'); // 'products' | 'research'
  const [showVendors, setShowVendors] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      adminFetch('/admin/inventory'),
      adminFetch('/admin/inventory/vendors'),
    ])
      .then(([inv, vend]) => {
        setProducts(inv.products || []);
        setStats(inv.stats || null);
        setCategories(inv.categories || []);
        setVendors(vend.vendors || []);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const [importingPricing, setImportingPricing] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const handleImportPricing = async () => {
    setImportingPricing(true);
    setImportResult(null);
    try {
      const r = await adminFetch('/admin/import/pricing', { method: 'POST' });
      setImportResult(r);
      // Reload inventory
      const inv = await adminFetch('/admin/inventory');
      setProducts(inv.products || []);
      setStats(inv.stats || null);
      setCategories(inv.categories || []);
    } catch (e) { setImportResult({ error: e.message }); }
    setImportingPricing(false);
  };

  // Derived counts
  const totalProducts = products.length;
  const pricedCount = products.filter(p => !p.needsPricing).length;
  const needsPricingCount = products.filter(p => p.needsPricing).length;

  // Filtered and sorted products
  const filtered = products
    .filter(p => {
      if (search) {
        const q = search.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !(p.activeIngredient || '').toLowerCase().includes(q)) return false;
      }
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
      if (needsPricingOnly && !p.needsPricing) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'price') return (a.bestPrice || 9999) - (b.bestPrice || 9999);
      return 0;
    });

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: D.muted, fontSize: 14 }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>Loading inventory...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: D.red, fontSize: 14 }}>
        <div style={{ fontSize: 18, marginBottom: 8 }}>Failed to load inventory</div>
        <div style={{ color: D.muted }}>{error}</div>
      </div>
    );
  }

  const inputStyle = {
    background: D.bg, border: `1px solid ${D.border}`, borderRadius: 8, padding: '8px 12px',
    color: D.text, fontSize: 13, outline: 'none', fontFamily: 'DM Sans, sans-serif',
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: D.white, margin: 0, fontFamily: 'DM Sans, sans-serif' }}>
            Product Inventory
          </h1>
          <p style={{ fontSize: 13, color: D.muted, margin: '4px 0 0' }}>Manage products and vendor pricing</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={() => setShowVendors(!showVendors)}
          style={{
            background: showVendors ? D.teal : D.card, border: `1px solid ${showVendors ? D.teal : D.border}`,
            borderRadius: 8, padding: '8px 16px', color: showVendors ? D.white : D.text,
            fontSize: 13, cursor: 'pointer', fontWeight: 600, transition: 'all 0.15s',
          }}
        >
          {showVendors ? 'Hide Vendors' : 'Show Vendors'}
        </button>
        </div>
      </div>

      {/* Stats bar */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <StatCard label="Total Products" value={totalProducts} />
        <StatCard label="Priced" value={pricedCount} color={D.green} />
        <StatCard label="Needs Pricing" value={needsPricingCount} color={needsPricingCount > 0 ? D.amber : D.muted} highlight={needsPricingCount > 0} />
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {[
          { key: 'products', label: 'All Products' },
          { key: 'research', label: `Price Research (${needsPricingCount})` },
        ].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
            background: activeTab === tab.key ? D.card : 'transparent',
            border: activeTab === tab.key ? `1px solid ${D.border}` : '1px solid transparent',
            borderRadius: 8, padding: '8px 16px', color: activeTab === tab.key ? D.white : D.muted,
            fontSize: 13, cursor: 'pointer', fontWeight: activeTab === tab.key ? 600 : 400,
            transition: 'all 0.15s',
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 20 }}>
        {/* Main content area */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {activeTab === 'products' && (
            <>
              {/* Filter bar */}
              <div style={{
                display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center',
              }}>
                <input
                  type="text"
                  placeholder="Search products..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  style={{ ...inputStyle, flex: '1 1 200px', minWidth: 180 }}
                />
                <select
                  value={categoryFilter}
                  onChange={e => setCategoryFilter(e.target.value)}
                  style={{ ...inputStyle, minWidth: 140 }}
                >
                  <option value="all">All Categories</option>
                  {categories.map(c => { const name = typeof c === 'string' ? c : c.name; return <option key={name} value={name}>{(name || '').charAt(0).toUpperCase() + (name || '').slice(1)}</option>; })}
                </select>
                <button
                  onClick={() => setNeedsPricingOnly(!needsPricingOnly)}
                  style={{
                    ...inputStyle,
                    cursor: 'pointer',
                    background: needsPricingOnly ? `${D.amber}22` : D.bg,
                    borderColor: needsPricingOnly ? D.amber : D.border,
                    color: needsPricingOnly ? D.amber : D.muted,
                    fontWeight: needsPricingOnly ? 600 : 400,
                  }}
                >
                  Needs Pricing
                </button>
                <select
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value)}
                  style={{ ...inputStyle, minWidth: 120 }}
                >
                  <option value="name">Sort: Name</option>
                  <option value="price">Sort: Price</option>
                </select>
              </div>

              {/* Product count */}
              <div style={{ fontSize: 12, color: D.muted, marginBottom: 10 }}>
                Showing {filtered.length} of {totalProducts} products
              </div>

              {/* Product list */}
              {filtered.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: D.muted, fontSize: 14 }}>
                  No products match your filters.
                </div>
              ) : (
                filtered.map(p => <ProductRow key={p.id} product={p} />)
              )}
            </>
          )}

          {activeTab === 'research' && (
            <PriceResearchQueue products={products} vendors={vendors} />
          )}
        </div>

        {/* Vendor sidebar */}
        {showVendors && (
          <div style={{ width: 280, flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: D.white, marginBottom: 12 }}>
              Vendors ({vendors.length})
            </div>
            <div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
              {vendors.map((v, i) => <VendorCard key={v.name || i} vendor={v} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
