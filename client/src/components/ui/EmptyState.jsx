import { cn } from './cn';

/**
 * EmptyState — the admin monochrome empty-state primitive (spec §3.11).
 *
 * Two forms:
 *   <EmptyState>No reviews yet</EmptyState>
 *     Children-only: the single centered muted line the dashboard charts have
 *     always rendered (promoted here from components/dashboard/charts.jsx,
 *     which re-exports it so its ~30 call sites don't churn).
 *
 *   <EmptyState size="page" icon={Inbox} title="No estimates yet"
 *               caption="Create or send an estimate before it appears here"
 *               action={<Button>CREATE ESTIMATE</Button>} />
 *     The full spec block: 240px centered, 32px outlined icon in tertiary,
 *     sentence-case headline, supporting caption, UPPERCASE primary action.
 *
 * Loading and error placeholders should keep using the children-only form —
 * the icon/title chrome reads as "empty", which is wrong for "loading".
 */
export function EmptyState({ icon: Icon, title, caption, action, size, className, children }) {
  if (!title) {
    return (
      <div className={cn('py-10 text-center text-13 text-ink-secondary', className)}>
        {children}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6',
        size === 'page' ? 'min-h-[240px]' : 'py-12',
        className,
      )}
    >
      {Icon && <Icon size={32} strokeWidth={1.5} className="text-ink-tertiary mb-3" aria-hidden />}
      <div className="text-14 font-medium text-ink-primary">{title}</div>
      {caption && <div className="mt-1 text-13 text-ink-tertiary">{caption}</div>}
      {action && <div className="mt-4">{action}</div>}
      {children}
    </div>
  );
}
