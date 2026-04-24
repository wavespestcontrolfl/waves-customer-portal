import { MessageSquare, Phone, Calendar, FileText, FilePlus2, Edit3, Send, CheckCircle2, PlayCircle, Clock, Link2, DollarSign } from 'lucide-react';
import { cn } from '../ui/cn';
import { callViaBridge } from './CallBridgeLink';

/**
 * Persistent bottom action bar for mobile admin detail views.
 * Renders above the MobileAdminShell's 56px tab bar → stack = 56 + 56 = 112px.
 * Only activates at viewport < 768px. Desktop continues using inline actions.
 *
 * Each action is a full-height equal-width column (not a pill) — icon 20px top,
 * label 11px bottom. Primary action uses zinc-900 fill; others neutral.
 */
/**
 * @param {object} p
 * @param {Array} p.actions  array of action descriptors (see variants below)
 * @param {string} [p.className]
 * @param {boolean} [p.standalone=false]  true when rendered inside a full-screen
 *   overlay that covers the MobileAdminShell tab bar (e.g. Customer360Profile).
 *   Default stacks above the tab bar (bottom = 56px + safe area).
 */
export default function StickyActionBar({ actions, className, standalone = false }) {
  if (!actions?.length) return null;
  const bottom = standalone
    ? 'env(safe-area-inset-bottom, 0)'
    : 'calc(56px + env(safe-area-inset-bottom, 0))';
  return (
    <div
      role="toolbar"
      aria-label="Actions"
      className={cn(
        'md:hidden fixed left-0 right-0 bg-white/95 backdrop-blur border-t border-hairline border-zinc-200',
        standalone ? 'z-[1001]' : 'z-30',
        className,
      )}
      style={{ bottom }}
    >
      <div className="flex items-stretch h-14">
        {actions.map((a, i) => (
          <ActionColumn key={a.key || i} action={a} />
        ))}
      </div>
    </div>
  );
}

function ActionColumn({ action }) {
  const { icon: Icon, label, onClick, href, disabled, primary, danger } = action;
  const cls = cn(
    'flex-1 flex flex-col items-center justify-center gap-1 transition-colors',
    'border-r border-hairline border-zinc-200 last:border-r-0',
    primary && !disabled && 'bg-zinc-900 text-white',
    !primary && !danger && !disabled && 'text-zinc-900 active:bg-zinc-50',
    danger && !disabled && 'text-alert-fg active:bg-alert-bg',
    disabled && 'text-zinc-300',
  );

  const content = (
    <>
      {Icon ? <Icon size={20} strokeWidth={primary ? 2.25 : 1.75} /> : null}
      <span className="text-[11px] leading-none tracking-label font-medium uppercase">
        {label}
      </span>
    </>
  );

  if (href && !disabled) {
    return <a href={href} className={cls}>{content}</a>;
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={cls}>
      {content}
    </button>
  );
}

// ─── Prebuilt variants ────────────────────────────────────────────────────

export function CustomerActionBar({ customer, standalone }) {
  const phone = customer?.phone;
  const customerId = customer?.id || customer?.customerId;

  // Build the Estimate prefill URL from whatever customer fields we have.
  // Falls back to /admin/estimates with no params (lands on Leads tab) when
  // the caller didn't pass enriched customer data.
  const estimateHref = (() => {
    const params = new URLSearchParams();
    const fullName = `${customer?.firstName || ''} ${customer?.lastName || ''}`.trim()
      || customer?.name
      || '';
    if (customer?.address) params.set('address', customer.address);
    if (fullName) params.set('customerName', fullName);
    if (phone) params.set('customerPhone', phone);
    if (customer?.email) params.set('customerEmail', customer.email);
    const qs = params.toString();
    return qs ? `/admin/estimates?${qs}` : '/admin/estimates';
  })();

  return (
    <StickyActionBar standalone={standalone} actions={[
      {
        key: 'text',
        icon: MessageSquare,
        label: 'Text',
        href: phone ? `/admin/communications?phone=${encodeURIComponent(phone)}&action=sms` : undefined,
        disabled: !phone,
      },
      {
        key: 'call',
        icon: Phone,
        label: 'Call',
        onClick: phone ? () => callViaBridge(phone, fullName) : undefined,
        disabled: !phone,
      },
      {
        key: 'estimate',
        icon: FilePlus2,
        label: 'Estimate',
        href: estimateHref,
      },
      {
        key: 'book',
        icon: Calendar,
        label: 'Book',
        href: customerId ? `/admin/schedule?customer=${customerId}` : undefined,
        primary: true,
        disabled: !customerId,
      },
      {
        key: 'invoice',
        icon: FileText,
        label: 'Invoice',
        href: customerId ? `/admin/invoices?customer=${customerId}` : undefined,
        disabled: !customerId,
      },
    ]} />
  );
}

export function EstimateActionBar({ estimateId, onEdit, onSend, onConvert, status }) {
  const canSend = status !== 'sent' && status !== 'accepted' && status !== 'declined';
  const canConvert = status === 'accepted';
  return (
    <StickyActionBar actions={[
      { key: 'edit', icon: Edit3, label: 'Edit', onClick: onEdit },
      { key: 'send', icon: Send, label: 'Send', onClick: onSend, disabled: !canSend, primary: !canConvert },
      { key: 'convert', icon: CheckCircle2, label: 'Convert', onClick: onConvert, disabled: !canConvert, primary: canConvert },
    ]} />
  );
}

export function JobActionBar({ status, onStart, onReschedule, onComplete }) {
  const canStart = status === 'scheduled' || status === 'pending';
  const canComplete = status === 'in_progress' || status === 'started';
  return (
    <StickyActionBar actions={[
      {
        key: 'start',
        icon: PlayCircle,
        label: 'Start',
        onClick: onStart,
        disabled: !canStart,
        primary: canStart,
      },
      {
        key: 'reschedule',
        icon: Clock,
        label: 'Reschedule',
        onClick: onReschedule,
      },
      {
        key: 'complete',
        icon: CheckCircle2,
        label: 'Complete',
        onClick: onComplete,
        disabled: !canComplete,
        primary: canComplete,
      },
    ]} />
  );
}

export function InvoiceActionBar({ invoiceId, onTextLink, onMarkPaid, onEdit, status }) {
  const canMarkPaid = status !== 'paid' && status !== 'voided';
  return (
    <StickyActionBar actions={[
      { key: 'text', icon: Link2, label: 'Text Link', onClick: onTextLink },
      {
        key: 'paid',
        icon: DollarSign,
        label: 'Mark Paid',
        onClick: onMarkPaid,
        disabled: !canMarkPaid,
        primary: canMarkPaid,
      },
      { key: 'edit', icon: Edit3, label: 'Edit', onClick: onEdit },
    ]} />
  );
}
