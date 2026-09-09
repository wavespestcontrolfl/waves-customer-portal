import { useId } from "react";
import { CalendarDays, CreditCard, History, FileText, MessageSquare, Phone, Search, ShieldCheck, Star, StickyNote } from "lucide-react";
import { Button, Card, Input, Select } from "../ui";
import { formatETDate, formatETDateOnly } from "../../lib/timezone";

const ACTIVITY_TYPES = {
  sms: { label: "Texts", Icon: MessageSquare },
  call: { label: "Calls", Icon: Phone },
  service: { label: "Services", Icon: ShieldCheck },
  invoice: { label: "Invoices", Icon: FileText },
  estimate: { label: "Estimates", Icon: FileText },
  payment: { label: "Payments", Icon: CreditCard },
  scheduled_service: { label: "Appointments", Icon: CalendarDays },
  interaction: { label: "Notes & interactions", Icon: StickyNote },
  review: { label: "Reviews", Icon: Star },
  activity: { label: "Account activity", Icon: History },
};

export default function Customer360Activity({ timeline, filter, onFilter, search = "", onSearch, error, retrying, onRetry, missingSources = [] }) {
  const id = useId();
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const entries = timeline.filter((item) => (filter === "all" || item.type === filter) && terms.every((term) => `${item.title || ""} ${item.description || ""}`.toLowerCase().includes(term)));
  return <section className="c360-activity" aria-labelledby={`${id}-heading`}>
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={`${id}-heading`} className="text-18 font-medium tracking-tight">Activity</h2>
      {!error && <span className="text-14 text-ink-secondary">{timeline.length} events</span>}
    </div>
    {missingSources.length > 0 && <p role="status" className="mb-3 text-14 text-ink-secondary">Some history is unavailable: {missingSources.join(", ")}. <button data-ui-text-action type="button" className="underline u-focus-ring" onClick={onRetry} disabled={retrying}>Retry</button></p>}
    <Card>
      <div className="c360-activity-toolbar">
        <label className="c360-search-field c360-activity-search">
          <Search size={17} aria-hidden="true" />
          <Input type="search" value={search} onChange={(event) => onSearch(event.target.value)} disabled={error} aria-label="Search activity" placeholder="Search activity…" className="!pl-9 !text-16" />
        </label>
        <Select className="c360-activity-filter !w-auto" aria-label="Filter activity" value={filter} onChange={(event) => onFilter(event.target.value)} disabled={error}>
          <option value="all">All activity</option>
          {Object.entries(ACTIVITY_TYPES).map(([type, item]) => <option key={type} value={type}>{item.label}</option>)}
        </Select>
      </div>
      <div className="c360-activity-list" role="region" aria-label="Customer activity history" tabIndex={0}>
        {error ? <div className="flex flex-col items-center gap-3 p-5"><p role="alert" className="text-14 text-alert-fg">Could not load customer history.</p><Button variant="secondary" aria-label="Retry customer history" onClick={onRetry} disabled={retrying}>{retrying ? "Retrying…" : "Retry"}</Button></div> : entries.map((item, index) => {
          const { Icon } = ACTIVITY_TYPES[item.type] || ACTIVITY_TYPES.activity;
          const formatDate = ["service", "scheduled_service"].includes(item.type) || /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? formatETDateOnly : formatETDate;
          const meta = item.metadata || {};
          const href = meta.callId ? `/admin/communications#tab=calls&call=${encodeURIComponent(meta.callId)}` : meta.invoiceId ? `/admin/invoices?invoice=${encodeURIComponent(meta.invoiceId)}` : meta.estimateId ? `/admin/estimates?estimateId=${encodeURIComponent(meta.estimateId)}` : null;
          return <details className="c360-activity-event" key={`${item.type}-${item.date}-${index}`}>
            <summary>
              <span className="c360-activity-icon"><Icon size={17} /></span>
              <span className="c360-activity-copy"><strong>{item.title}</strong>{item.description && <span>{item.description}</span>}</span>
              <span className="c360-activity-date">{item.date ? formatDate(item.date, { month: "short", day: "numeric", year: "numeric" }) : "No date"}</span>
            </summary>
            <div className="c360-activity-description">{item.description || "No additional details."}{href && <p className="mt-3"><a href={href} className="u-focus-ring underline">{meta.callId ? "Open call, transcript & outcome" : "Open record"}</a></p>}</div>
          </details>;
        })}
        {!error && entries.length === 0 && <p className="p-5 text-14 text-ink-secondary">{terms.length ? "No matching activity." : "No activity in this category."}</p>}
      </div>
      {!error && <div className="c360-activity-footer">{filter === "all" && terms.length === 0 ? missingSources.length ? "Loaded history" : "All available history" : `${entries.length} matching events`}</div>}
    </Card>
  </section>;
}
