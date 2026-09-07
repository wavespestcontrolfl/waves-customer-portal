import { useId } from "react";
import { CalendarDays, CreditCard, History, MessageSquare, Phone, ShieldCheck, Star, StickyNote } from "lucide-react";
import { Button, Card } from "../ui";
import { formatETDate, formatETDateOnly } from "../../lib/timezone";

const ACTIVITY_TYPES = {
  sms: { label: "Texts", Icon: MessageSquare },
  call: { label: "Calls", Icon: Phone },
  service: { label: "Services", Icon: ShieldCheck },
  payment: { label: "Payments", Icon: CreditCard },
  scheduled_service: { label: "Appointments", Icon: CalendarDays },
  interaction: { label: "Notes & interactions", Icon: StickyNote },
  review: { label: "Reviews", Icon: Star },
  activity: { label: "Account activity", Icon: History },
};

export default function Customer360Activity({ timeline, filter, onFilter, error, retrying, onRetry }) {
  const id = useId();
  const entries = filter === "all" ? timeline : timeline.filter((item) => item.type === filter);
  return <section className="c360-activity" aria-labelledby={`${id}-heading`}>
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 id={`${id}-heading`} className="text-18 font-medium tracking-tight">Activity</h2>
      {!error && <span className="text-14 text-ink-secondary">{timeline.length} events</span>}
    </div>
    <Card>
      <div className="c360-activity-toolbar">
        <span className="flex items-center gap-2 text-14 text-ink-secondary"><History size={16} />All time</span>
        <select aria-label="Filter activity" value={filter} onChange={(event) => onFilter(event.target.value)} disabled={error}>
          <option value="all">All activity</option>
          {Object.entries(ACTIVITY_TYPES).map(([type, item]) => <option key={type} value={type}>{item.label}</option>)}
        </select>
      </div>
      <div className="c360-activity-list" role="region" aria-label="Customer activity history" tabIndex={0}>
        {error ? <div className="flex flex-col items-center gap-3 p-5"><p role="alert" className="text-14 text-alert-fg">Could not load customer history.</p><Button variant="secondary" aria-label="Retry customer history" onClick={onRetry} disabled={retrying}>{retrying ? "Retrying…" : "Retry"}</Button></div> : entries.map((item, index) => {
          const { Icon } = ACTIVITY_TYPES[item.type] || ACTIVITY_TYPES.activity;
          const formatDate = ["service", "scheduled_service"].includes(item.type) || /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? formatETDateOnly : formatETDate;
          return <details className="c360-activity-event" key={`${item.type}-${item.date}-${index}`}>
            <summary>
              <span className="c360-activity-icon"><Icon size={17} /></span>
              <span className="c360-activity-copy"><strong>{item.title}</strong>{item.description && <span>{item.description}</span>}</span>
              <span className="c360-activity-date">{item.date ? formatDate(item.date, { month: "short", day: "numeric", year: "numeric" }) : "No date"}</span>
            </summary>
            <div className="c360-activity-description">{item.description || "No additional details."}</div>
          </details>;
        })}
        {!error && entries.length === 0 && <p className="p-5 text-14 text-ink-secondary">No activity in this category.</p>}
      </div>
      {!error && <div className="c360-activity-footer">{filter === "all" ? "All available history" : `${entries.length} matching events`}</div>}
    </Card>
  </section>;
}
