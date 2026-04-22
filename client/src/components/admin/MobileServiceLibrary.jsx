// Mobile-only Service Library views. Rendered from ServiceLibraryPage when
// viewport < 768px. Three drill-in views mirroring the attached reference:
//   - Categories       — services grouped by `category`, item counts + subcategory counts
//   - Discounts        — list from GET /admin/discounts with % / $ suffix
//   - All Services     — flat list from GET /admin/services (+ Create Service CTA)
//
// Desktop ServiceLibraryPage (tabs + filters + grouped catalog) is unchanged.

import { useState, useEffect, useCallback, useMemo } from 'react';

const API = import.meta.env.VITE_API_URL || '/api';

function aFetch(path, opts = {}) {
  return fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
    },
    ...opts,
  }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

// Mirrors CATEGORIES in ServiceLibraryPage.jsx; kept local so this file has no
// import-time coupling. Keep labels in sync when new categories are added.
const CATEGORY_LABELS = {
  pest_control: 'Pest Control',
  lawn_care: 'Lawn Care',
  mosquito: 'Mosquito',
  termite: 'Termite',
  rodent: 'Rodent',
  tree_shrub: 'Tree & Shrub',
  inspection: 'Inspection',
  specialty: 'Specialty',
  other: 'Other',
};

// Shared row + card styling so the three views look identical.
const rowChrome = 'flex items-center gap-3 bg-white border-hairline border-zinc-200 rounded-sm px-3 no-underline';

function SearchBar({ value, onChange, placeholder }) {
  return (
    <div className="relative mb-3">
      <span aria-hidden className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-tertiary" style={{ fontSize: 14 }}>
        ⌕
      </span>
      <input
        type="search"
        inputMode="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="block w-full bg-white text-14 text-ink-primary border-hairline border-zinc-300 rounded-full h-12 pl-10 pr-4 focus:outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900"
      />
    </div>
  );
}

function Header({ title, onBack, onAdd, centerTitle = false }) {
  return (
    <div className="flex items-center justify-between mb-3" style={{ minHeight: 44 }}>
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="flex items-center justify-center rounded-full bg-zinc-100 u-focus-ring"
        style={{ width: 40, height: 40, fontSize: 16, lineHeight: 1 }}
      >
        ←
      </button>
      {centerTitle && (
        <div className="flex-1 text-center font-semibold text-zinc-900" style={{ fontSize: 17 }}>
          {title}
        </div>
      )}
      {onAdd ? (
        <button
          type="button"
          onClick={onAdd}
          aria-label="Add"
          className="flex items-center justify-center rounded-full bg-zinc-900 text-white u-focus-ring"
          style={{ width: 40, height: 40, fontSize: 22, lineHeight: 1 }}
        >
          +
        </button>
      ) : (
        <div style={{ width: 40, height: 40 }} />
      )}
    </div>
  );
}

function LargeTitle({ children }) {
  return (
    <h1 className="text-zinc-900 tracking-tight mb-4" style={{ fontSize: 32, fontWeight: 800 }}>
      {children}
    </h1>
  );
}

// ── Menu (top of stack) ─────────────────────────────────────────────────
function MenuView({ onNav }) {
  const items = [
    { key: 'categories', label: 'Categories', hint: 'Group services by type' },
    { key: 'discounts', label: 'Discounts', hint: 'Percentage & dollar discounts' },
    { key: 'services', label: 'All Services', hint: 'Every service in the library' },
  ];
  return (
    <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 640 }}>
      <h1 className="text-zinc-900 tracking-tight mb-4" style={{ fontSize: 32, fontWeight: 800 }}>
        Service Library
      </h1>
      <div className="flex flex-col gap-2">
        {items.map((it) => (
          <button
            key={it.key}
            type="button"
            onClick={() => onNav(it.key)}
            className={`${rowChrome} justify-between cursor-pointer hover:bg-zinc-50 text-left`}
            style={{ height: 64 }}
          >
            <div className="flex-1 min-w-0">
              <div className="font-medium text-ink-primary" style={{ fontSize: 15 }}>{it.label}</div>
              <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>{it.hint}</div>
            </div>
            <span aria-hidden className="text-ink-secondary" style={{ fontSize: 20 }}>›</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Thumbnail (small square with Waves logo or category accent) ─────────
function Thumb({ color = '#E4E4E7', icon }) {
  return (
    <div
      className="flex items-center justify-center rounded-sm shrink-0"
      style={{ width: 44, height: 44, background: color, color: '#18181B' }}
      aria-hidden
    >
      {icon || <img src="/waves-logo.png" alt="" className="w-8 h-8 object-contain" />}
    </div>
  );
}

// ── Categories view ─────────────────────────────────────────────────────
function CategoriesView({ onBack }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    aFetch('/admin/services?is_active=true&limit=500')
      .then((d) => { setServices(d.services || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const groups = useMemo(() => {
    // Group services by `category`. Count distinct subcategories within each.
    const map = new Map();
    for (const s of services) {
      const key = s.category || 'other';
      if (!map.has(key)) map.set(key, { key, services: [], subs: new Set() });
      const g = map.get(key);
      g.services.push(s);
      if (s.subcategory) g.subs.add(s.subcategory);
    }
    const q = query.trim().toLowerCase();
    return Array.from(map.values())
      .map((g) => ({
        key: g.key,
        label: CATEGORY_LABELS[g.key] || g.key,
        itemCount: g.services.length,
        subCount: g.subs.size,
      }))
      .filter((g) => !q || g.label.toLowerCase().includes(q))
      .sort((a, b) => b.itemCount - a.itemCount);
  }, [services, query]);

  return (
    <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 640 }}>
      <Header title="Categories" onBack={onBack} onAdd={() => alert('Create category — coming soon')} />
      <LargeTitle>Categories</LargeTitle>
      <SearchBar value={query} onChange={setQuery} placeholder="Search Categories" />
      {loading ? (
        <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>No categories</div>
      ) : (
        <div className="flex flex-col gap-2">
          {groups.map((g) => (
            <div key={g.key} className={`${rowChrome} justify-between`} style={{ height: 64 }}>
              <Thumb />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-ink-primary truncate" style={{ fontSize: 15 }}>{g.label}</div>
                <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>
                  {g.subCount} subcategor{g.subCount === 1 ? 'y' : 'ies'}
                </div>
              </div>
              <div className="flex items-center gap-1 text-ink-secondary" style={{ fontSize: 14 }}>
                <span className="u-nums">{g.itemCount} item{g.itemCount === 1 ? '' : 's'}</span>
                <span aria-hidden style={{ fontSize: 18, lineHeight: 1 }}>›</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Discounts view ──────────────────────────────────────────────────────
function DiscountsView({ onBack }) {
  const [discounts, setDiscounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    aFetch('/admin/discounts')
      .then((d) => {
        // Endpoint returns a raw array.
        setDiscounts(Array.isArray(d) ? d : (d.discounts || []));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const formatAmount = (d) => {
    const amt = Number(d.amount || 0);
    if (d.discount_type === 'percentage' || d.discount_type === 'variable_percentage') {
      return `${amt.toFixed(0)}%`;
    }
    if (d.discount_type === 'fixed_amount' || d.discount_type === 'variable_amount') {
      return `−$${amt.toFixed(2)}`;
    }
    if (d.discount_type === 'free_service') return 'Free';
    return amt ? String(amt) : '—';
  };

  const q = query.trim().toLowerCase();
  const list = discounts.filter((d) => d.is_active !== false)
    .filter((d) => !q || (d.name || '').toLowerCase().includes(q));

  return (
    <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 640 }}>
      <Header
        title="Discounts"
        centerTitle
        onBack={onBack}
        onAdd={() => alert('Create discount — use the desktop Service Library > Discounts tab')}
      />
      <SearchBar value={query} onChange={setQuery} placeholder="Search discounts" />
      {loading ? (
        <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>Loading…</div>
      ) : list.length === 0 ? (
        <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>No discounts</div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((d) => (
            <div key={d.id} className={`${rowChrome} justify-between`} style={{ height: 64 }}>
              <Thumb color="#F4F4F5" icon={<span style={{ fontSize: 18 }} aria-hidden>🏷</span>} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-ink-primary truncate" style={{ fontSize: 15 }}>{d.name}</div>
              </div>
              <div className="flex items-center gap-1 text-ink-primary" style={{ fontSize: 14 }}>
                <span className="u-nums font-medium">{formatAmount(d)}</span>
                <span aria-hidden className="text-ink-secondary" style={{ fontSize: 18, lineHeight: 1 }}>›</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── All Services view ───────────────────────────────────────────────────
function AllServicesView({ onBack }) {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    aFetch('/admin/services?is_active=true&limit=500')
      .then((d) => { setServices(d.services || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const formatDuration = (m) => {
    const n = Number(m || 0);
    if (!n) return '';
    if (n === 60) return '1 hr';
    if (n % 60 === 0) return `${n / 60} hr`;
    if (n < 60) return `${n} min`;
    return `${Math.floor(n / 60)} hr ${n % 60} min`;
  };

  const formatPrice = (s) => {
    if (s.pricing_type === 'variable' || s.pricing_type === 'quoted') return 'Variable';
    const p = Number(s.base_price || 0);
    return p ? `$${p.toFixed(0)}` : 'Variable';
  };

  const q = query.trim().toLowerCase();
  const list = services
    .filter((s) => !q || (s.name || '').toLowerCase().includes(q))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 640 }}>
      <Header title="All Services" centerTitle onBack={onBack} />
      <button
        type="button"
        onClick={() => alert('Create Service — use the desktop Service Library > + Add Service')}
        className="w-full bg-zinc-100 text-zinc-900 font-semibold rounded-sm u-focus-ring mt-2"
        style={{ padding: '18px 20px', fontSize: 16 }}
      >
        Create Service
      </button>
      <div className="mt-3">
        <SearchBar value={query} onChange={setQuery} placeholder="Search All Services" />
      </div>
      {loading ? (
        <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>Loading…</div>
      ) : list.length === 0 ? (
        <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>No services</div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((s) => {
            const duration = formatDuration(s.default_duration_minutes);
            const price = formatPrice(s);
            return (
              <div key={s.id} className={`${rowChrome} justify-between`} style={{ height: 68 }}>
                <Thumb color={s.color || '#E4E4E7'} />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-ink-primary truncate" style={{ fontSize: 15 }}>{s.name}</div>
                  {duration && (
                    <div className="text-ink-tertiary truncate" style={{ fontSize: 12, marginTop: 2 }}>{duration}</div>
                  )}
                </div>
                <div className="u-nums font-medium text-ink-primary" style={{ fontSize: 14 }}>{price}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Root mobile component ───────────────────────────────────────────────
export default function MobileServiceLibrary() {
  const [view, setView] = useState('menu'); // 'menu' | 'categories' | 'discounts' | 'services'
  const onBack = () => setView('menu');

  if (view === 'categories') return <CategoriesView onBack={onBack} />;
  if (view === 'discounts') return <DiscountsView onBack={onBack} />;
  if (view === 'services') return <AllServicesView onBack={onBack} />;
  return <MenuView onNav={setView} />;
}
