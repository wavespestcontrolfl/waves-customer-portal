import { AlertTriangle, HelpCircle } from 'lucide-react';
import { cn } from '../ui';

export default function DispatchReadinessStrip({ readiness, onOpen, compact = false, iconOnly = false, className }) {
  if (!readiness || !onOpen) return null;
  const issues = readiness.issues || [];
  const hasHold = issues.some(issue => issue.status === 'hold');
  const label = issues.length ? issues.map(issue => issue.label).join(' · ') : 'View Job Card';
  const Icon = hasHold ? AlertTriangle : HelpCircle;
  return (
    <button
      type="button"
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); onOpen(); }}
      className={cn(
        'flex items-center gap-1 rounded-xs border-hairline px-1 text-14 leading-5 text-left u-focus-ring',
        hasHold ? 'bg-alert-bg text-alert-fg border-alert-fg' : 'bg-zinc-50 text-zinc-700 border-zinc-300',
        compact ? 'h-5 max-w-full' : 'min-h-11 w-full py-1',
        iconOnly && 'w-5 justify-center p-0',
        className,
      )}
      title={`${label}. Open Job Card for product and visit details. Company stock is not a truck count.`}
      aria-label={`${label}. Open Job Card`}
    >
      {(issues.length > 0 || iconOnly) && <Icon size={14} className="shrink-0" aria-hidden="true" />}
      {!iconOnly && <span className={compact ? 'truncate' : ''}>{label}</span>}
    </button>
  );
}
