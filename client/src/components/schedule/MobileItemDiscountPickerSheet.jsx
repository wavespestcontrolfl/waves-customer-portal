// Full-screen picker shown from MobileCheckoutSheet's "Add Item or Discount"
// button. Mirrors the Jobber-style reference: X-close header, search bar,
// then three quick-action rows (Gift Cards, Redeem Rewards, Custom Amount)
// above the full discount list. Tapping a row calls onSelect() with a shape
// the caller turns into a checkout line item.
//
// onSelect payload shapes:
//   Discount: { kind: 'discount', discount }            // full DB row
//   Custom $: { kind: 'custom_amount', label, amount }
//   Custom D: { kind: 'custom_discount', discount_type, amount }

import { useEffect, useState } from 'react';
import { X, Tag, Gift, Star, DollarSign } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    ...opts,
  }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function formatAmount(d) {
  const amt = Number(d.amount || 0);
  if (d.discount_type === 'percentage' || d.discount_type === 'variable_percentage') {
    return `${amt.toFixed(0)}%`;
  }
  if (d.discount_type === 'fixed_amount' || d.discount_type === 'variable_amount') {
    return `−$${amt.toFixed(2)}`;
  }
  if (d.discount_type === 'free_service') return 'Free';
  return amt ? String(amt) : '—';
}

export default function MobileItemDiscountPickerSheet({ onClose, onSelect }) {
  const [discounts, setDiscounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    adminFetch('/admin/discounts')
      .then((d) => { setDiscounts(Array.isArray(d) ? d : (d.discounts || [])); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleCustomAmount = () => {
    const input = window.prompt('Custom amount (negative for a discount):');
    if (input == null) return;
    const amt = Number(input);
    if (!Number.isFinite(amt) || amt === 0) return;
    const label = window.prompt('Label (shown on invoice):', amt < 0 ? 'Custom Discount' : 'Custom Item') || (amt < 0 ? 'Custom Discount' : 'Custom Item');
    onSelect?.({ kind: 'custom_amount', label, amount: amt });
  };

  const handleCustomDiscount = (type) => {
    const input = window.prompt(type === 'percent' ? 'Discount % (0-100):' : 'Discount $ amount:');
    if (input == null) return;
    const amt = Number(input);
    if (!Number.isFinite(amt) || amt <= 0) return;
    onSelect?.({
      kind: 'custom_discount',
      discount_type: type === 'percent' ? 'percentage' : 'fixed_amount',
      amount: amt,
    });
  };

  const q = query.trim().toLowerCase();
  const activeDiscounts = discounts
    .filter((d) => d.is_active !== false)
    .filter((d) => !q || (d.name || '').toLowerCase().includes(q));

  const QuickRow = ({ icon, label, onClick, disabled }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-3 py-3 border-b border-hairline border-zinc-200 text-left w-full u-focus-ring disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div
        className="flex items-center justify-center rounded-sm shrink-0 text-zinc-600"
        style={{ width: 56, height: 56, background: '#E4E4E7' }}
        aria-hidden
      >
        {icon}
      </div>
      <div className="flex-1 font-semibold text-ink-primary" style={{ fontSize: 15 }}>{label}</div>
    </button>
  );

  return (
    <div className="fixed inset-0 z-[60] bg-white overflow-y-auto md:hidden">
      <div
        className="sticky top-0 bg-white border-b border-hairline border-zinc-200 flex items-center px-3"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex items-center justify-center h-11 w-11 u-focus-ring text-zinc-900"
        >
          <X size={22} strokeWidth={1.75} />
        </button>
        <div className="flex-1 text-center font-medium text-zinc-900" style={{ fontSize: 16 }}>
          Add Item or Discount
        </div>
        <div className="w-11" />
      </div>

      <div className="px-4 pt-4 pb-10 mx-auto" style={{ maxWidth: 640 }}>
        <div className="relative mb-3">
          <span aria-hidden className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-tertiary" style={{ fontSize: 14 }}>⌕</span>
          <input
            type="search"
            inputMode="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="block w-full bg-zinc-100 text-14 text-ink-primary border-0 rounded-sm h-12 pl-10 pr-4 focus:outline-none focus:ring-2 focus:ring-zinc-900"
          />
        </div>

        <div className="flex flex-col">
          {/* Quick-action rows (match reference grayed-out treatment) */}
          <QuickRow
            icon={<Gift size={22} strokeWidth={1.75} />}
            label="Gift Cards"
            disabled
            onClick={() => {}}
          />
          <QuickRow
            icon={<Star size={22} strokeWidth={1.75} />}
            label="Redeem Rewards"
            disabled
            onClick={() => {}}
          />
          <QuickRow
            icon={<DollarSign size={22} strokeWidth={1.75} />}
            label="Custom Amount"
            onClick={handleCustomAmount}
          />

          {/* Custom discount rows */}
          <button
            type="button"
            onClick={() => handleCustomDiscount('dollar')}
            className="flex items-center gap-3 py-3 border-b border-hairline border-zinc-200 cursor-pointer hover:bg-zinc-50 text-left u-focus-ring"
          >
            <div className="flex items-center justify-center rounded-sm shrink-0 text-zinc-600" style={{ width: 56, height: 56, background: '#FFFFFF', border: '1px solid #E4E4E7' }} aria-hidden>
              <Tag size={22} strokeWidth={1.75} />
            </div>
            <div className="flex-1 font-semibold text-ink-primary" style={{ fontSize: 15 }}>Custom Discount</div>
            <div className="text-ink-secondary" style={{ fontSize: 14 }}>Variable $</div>
          </button>
          <button
            type="button"
            onClick={() => handleCustomDiscount('percent')}
            className="flex items-center gap-3 py-3 border-b border-hairline border-zinc-200 cursor-pointer hover:bg-zinc-50 text-left u-focus-ring"
          >
            <div className="flex items-center justify-center rounded-sm shrink-0 text-zinc-600" style={{ width: 56, height: 56, background: '#FFFFFF', border: '1px solid #E4E4E7' }} aria-hidden>
              <Tag size={22} strokeWidth={1.75} />
            </div>
            <div className="flex-1 font-semibold text-ink-primary" style={{ fontSize: 15 }}>Custom Discount</div>
            <div className="text-ink-secondary" style={{ fontSize: 14 }}>Variable %</div>
          </button>

          {/* Library discounts */}
          {loading ? (
            <div className="p-10 text-center text-ink-secondary" style={{ fontSize: 13 }}>Loading…</div>
          ) : activeDiscounts.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => onSelect?.({ kind: 'discount', discount: d })}
              className="flex items-center gap-3 py-3 border-b border-hairline border-zinc-200 cursor-pointer hover:bg-zinc-50 text-left u-focus-ring"
            >
              <div className="flex items-center justify-center rounded-sm shrink-0 text-zinc-600" style={{ width: 56, height: 56, background: '#FFFFFF', border: '1px solid #E4E4E7' }} aria-hidden>
                <Tag size={22} strokeWidth={1.75} />
              </div>
              <div className="flex-1 min-w-0 font-semibold text-ink-primary truncate" style={{ fontSize: 15 }}>{d.name}</div>
              <div className="u-nums font-medium text-ink-primary shrink-0" style={{ fontSize: 14 }}>{formatAmount(d)}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
