// Mobile-only Square-style Settings index (IMG_3734).
// Rendered by SettingsPage at /admin/settings below the md breakpoint.
//
// Layout:
//   · big "Settings" heading
//   · rounded search pill (filters the section list)
//   · vertical list of big section labels; tap → navigates to the
//     existing destination (Banking, Communications, etc.) or deep-links
//     into a specific tab of the V1 desktop SettingsPage (?tab=team etc.)
//
// Destinations that already exist as standalone routes are linked
// directly. Tabs that only live inside SettingsPage (general, integrations,
// geofence, gates, team, system) deep-link via ?tab=X — the desktop
// SettingsPage now reads that param on mount.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';

const SECTIONS = [
  { key: 'invoices',        label: 'Invoices',           to: '/admin/invoices' },
  { key: 'payments',        label: 'Payments',           to: '/admin/banking' },
  { key: 'tap-to-pay',      label: 'Tap to Pay',         to: '/admin/settings?tab=integrations' },
  { key: 'communications',  label: 'Communications',     to: '/admin/communications' },
  { key: 'team',            label: 'Team',               to: '/admin/settings?tab=team' },
  { key: 'integrations',    label: 'Integrations',       to: '/admin/settings?tab=integrations' },
  { key: 'automation',      label: 'Automation',         to: '/admin/settings?tab=geofence' },
  { key: 'account',         label: 'Account',            to: '/admin/settings?tab=general' },
  { key: 'system',          label: 'System',             to: '/admin/settings?tab=system' },
  { key: 'feature-flags',   label: 'Early feature access', to: '/admin/_design-system/flags' },
];

export default function MobileSettingsPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return SECTIONS;
    return SECTIONS.filter((sec) => sec.label.toLowerCase().includes(s));
  }, [q]);

  return (
    <div className="md:hidden">
      {/* Heading */}
      <h1
        className="text-zinc-900"
        style={{
          fontSize: 34,
          fontWeight: 700,
          letterSpacing: '-0.015em',
          marginTop: 4,
          marginBottom: 16,
        }}
      >
        Settings
      </h1>

      {/* Search pill */}
      <div
        className="flex items-center gap-3 rounded-full border-hairline border-zinc-200 bg-white"
        style={{ height: 48, paddingLeft: 18, paddingRight: 18 }}
      >
        <Search size={18} strokeWidth={1.75} className="text-zinc-500" />
        <input
          type="search"
          inputMode="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="flex-1 bg-transparent outline-none text-zinc-900"
          style={{ fontSize: 15 }}
          aria-label="Search settings"
        />
      </div>

      {/* Section list — big labels, generous vertical spacing, no chevrons
          per IMG_3734. */}
      <div style={{ marginTop: 22 }}>
        {filtered.map((sec) => (
          <button
            key={sec.key}
            type="button"
            onClick={() => navigate(sec.to)}
            className="w-full text-left text-zinc-900 active:bg-zinc-50 u-focus-ring"
            style={{
              padding: '18px 0',
              borderBottom: '1px solid transparent', /* Square has no dividers here */
              fontSize: 18,
              fontWeight: 700,
              lineHeight: 1.2,
              letterSpacing: '-0.005em',
              display: 'block',
              background: 'transparent',
              border: 'none',
            }}
          >
            {sec.label}
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="text-ink-tertiary" style={{ fontSize: 14, padding: '18px 0' }}>
            No matching settings.
          </div>
        )}
      </div>
    </div>
  );
}
