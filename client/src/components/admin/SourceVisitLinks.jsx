import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { formatETDateOnly } from "../../lib/timezone";
import { Button } from "../ui";

const linkClass = "block w-fit font-medium text-zinc-900 underline u-focus-ring";

// The disclosures mount this reader only when opened. Each endpoint returns
// record-linked visits and the invoices attached to those specific visits.
export default function SourceVisitLinks({ kind, id, read }) {
  const [result, setResult] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const key = encodeURIComponent(id);
    const path = kind === "call"
      ? `/ai/admin/calls?id=${key}&include_outcomes=1&include_month=0`
      : `/admin/leads/${key}?include_outcomes=1`;
    setResult(null);
    read(path).then((data) => {
      const record = kind === "call" ? data.calls?.find((entry) => entry.id === id) : data;
      if (!Array.isArray(record?.related_visits)) throw new Error("Visit links unavailable");
      if (active) setResult({ visits: record.related_visits, hasMore: record.related_visits_has_more });
    }).catch(() => { if (active) setResult({ failed: true }); });
    return () => { active = false; };
  }, [kind, id, read, retry]);
  if (!result) return <span role="status">Loading linked visits…</span>;
  if (result.failed) return <div>Visit links unavailable. <Button type="button" variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>Retry links</Button></div>;
  if (!result.visits.length) return <span>No visit linked to this {kind}.</span>;
  return (
    <div className="space-y-2">
      {result.visits.map((visit) => (
        <div key={visit.id} className="space-y-1">
          <Link to={`/admin/dispatch?tab=schedule&date=${encodeURIComponent(String(visit.scheduled_date).slice(0, 10))}&appointment=${encodeURIComponent(visit.id)}`} className={linkClass}>
            {formatETDateOnly(visit.scheduled_date, { month: "short", day: "numeric" })} visit · {visit.status.replace(/_/g, " ")}
          </Link>
          {visit.invoices.map((invoice) => (
            <Link key={invoice.id} to={`/admin/invoices?invoice=${encodeURIComponent(invoice.id)}`} className={linkClass}>Invoice · {invoice.status}</Link>
          ))}
        </div>
      ))}
      {result.hasMore && <span>Showing the {result.visits.length} most recent linked visits.</span>}
    </div>
  );
}

export function LeadVisitDisclosure({ id, read }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-2 text-14" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="w-fit cursor-pointer rounded-sm font-medium text-zinc-900 u-focus-ring">Linked visits and invoices</summary>
      {open && <div className="mt-2"><SourceVisitLinks kind="lead" id={id} read={read} /></div>}
    </details>
  );
}
