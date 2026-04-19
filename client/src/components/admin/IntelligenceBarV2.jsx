/**
 * Intelligence Bar — V2 (customer-search wrapper)
 * client/src/components/admin/IntelligenceBarV2.jsx
 *
 * Thin wrapper around IntelligenceBarShell. Default customers context (no
 * context string sent → server defaults). Renders a customer-list result card
 * under any response that returns `customers` or `overdue_customers`.
 */

import { cn } from '../ui';
import IntelligenceBarShell from './IntelligenceBarShell';

const FALLBACK_ACTIONS = [
  { id: 'missing_city', label: 'Missing Cities', prompt: 'Show me customers with no city on their profile' },
  { id: 'pest_overdue', label: 'Pest Overdue', prompt: 'Which quarterly pest control customers are overdue for service?' },
  { id: 'lawn_overdue', label: 'Lawn Overdue', prompt: 'Which monthly lawn care customers are overdue?' },
  { id: 'at_risk', label: 'At Risk', prompt: 'Show me customers with health scores below 40' },
  { id: 'high_balance', label: 'Balances', prompt: 'Who has an outstanding balance over $100?' },
  { id: 'duplicates', label: 'Duplicates', prompt: 'Find duplicate customers by phone number' },
  { id: 'tech_perf', label: 'Tech Stats', prompt: 'Compare technician performance this month' },
  { id: 'win_back', label: 'Win Back', prompt: 'Show churned Gold/Platinum customers from the last 6 months' },
];

function CustomerRow({ customer, onSelect }) {
  const c = customer;
  const name = c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Unnamed';
  const healthLow = c.health_score != null && c.health_score < 40;
  const overdueBad = c.days_overdue != null && c.days_overdue > 30;

  return (
    <div
      onClick={() => onSelect?.(c.id)}
      className="flex items-center gap-3 px-3 py-2 border-b border-hairline border-zinc-200 last:border-b-0 cursor-pointer hover:bg-zinc-50 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="text-13 font-medium text-ink-primary truncate">{name}</div>
        <div className="text-11 text-ink-tertiary">
          {c.city || '—'}{c.phone ? ` · ${c.phone}` : ''}
        </div>
      </div>
      {c.tier && (
        <span className="inline-flex items-center h-5 px-2 text-10 font-medium uppercase tracking-label border-hairline border-zinc-200 text-ink-secondary rounded-xs">
          {c.tier}
        </span>
      )}
      {c.health_score != null && (
        <span className={cn('u-nums text-11 font-medium', healthLow ? 'text-alert-fg' : 'text-ink-primary')}>
          {c.health_score}
        </span>
      )}
      {c.days_overdue != null && (
        <span className={cn('u-nums text-10 font-medium', overdueBad ? 'text-alert-fg' : 'text-ink-secondary')}>
          {c.days_overdue}d overdue
        </span>
      )}
      {c.monthly_rate > 0 && (
        <span className="u-nums text-11 text-ink-secondary">
          ${c.monthly_rate.toFixed(0)}/mo
        </span>
      )}
    </div>
  );
}

export default function IntelligenceBarV2({ onSelectCustomer }) {
  return (
    <IntelligenceBarShell
      fallbackActions={FALLBACK_ACTIONS}
      placeholder="Ask anything about your customers, schedule, or revenue…"
      recentsEnabled
      responseSlot={(data) => {
        const list = data?.customers || data?.overdue_customers;
        if (!list?.length) return null;
        return (
          <div className="mt-3 border-hairline border-zinc-200 rounded-sm overflow-hidden max-h-[300px] overflow-y-auto">
            <div className="px-3 py-2 bg-zinc-50 border-b border-hairline border-zinc-200 flex items-center justify-between">
              <span className="u-label text-ink-secondary">Results ({list.length})</span>
              {data?.total_matching != null && data.total_matching > list.length && (
                <span className="text-11 text-ink-tertiary">
                  showing {list.length} of {data.total_matching}
                </span>
              )}
            </div>
            {list.map((c, i) => (
              <CustomerRow key={c.id || i} customer={c} onSelect={onSelectCustomer} />
            ))}
          </div>
        );
      }}
    />
  );
}
