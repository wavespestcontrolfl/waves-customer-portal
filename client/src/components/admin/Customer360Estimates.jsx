import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import { buttonStyles, Badge, Card, Input } from "../ui";
import { formatETDate } from "../../lib/timezone";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

function quotedAmount(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "Not recorded";
  return money.format(Number(value));
}

// These are the stored quote totals already returned by the customer endpoint.
// Do not reprice a historical estimate from the customer's current plan.
export default function Customer360Estimates({ estimates }) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const matches = estimates.filter((estimate) => [estimate.id, estimate.estimate_slug, estimate.service_interest, estimate.status].join(" ").toLowerCase().includes(query));

  return <section className="c360-estimates" aria-labelledby="c360-estimates-heading">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 id="c360-estimates-heading" className="text-18 font-medium">Estimates</h2>
      <span className="text-14 text-ink-secondary">{estimates.length} total</span>
    </div>
    <p className="mb-4 text-14 text-ink-secondary">Reference the original quote and its recorded totals.</p>
    <label className="c360-search-field mb-4">
      <Search size={17} aria-hidden="true" />
      <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search estimates" placeholder="Search reference, service, or status…" className="!pl-9 !text-16" />
    </label>
    <div className="flex flex-col gap-3">
      {matches.map((estimate) => <Card key={estimate.id} className="c360-estimate-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <a className="c360-estimate-reference u-focus-ring" href={`/admin/estimates?estimateId=${encodeURIComponent(estimate.id)}`}>#{estimate.estimate_slug || estimate.id.slice(0, 8)}<ArrowUpRight size={17} aria-hidden="true" /></a>
            <p className="mt-2 text-14 text-ink-secondary">{estimate.service_interest || "Estimate"}</p>
          </div>
          <Badge className="!h-auto !min-h-6 !py-1 normal-case tracking-normal">{estimate.status || "Unknown status"}{estimate.archived_at && " · Archived"}</Badge>
        </div>
        <dl className="c360-estimate-totals">
          <div><dt>Quoted monthly</dt><dd>{quotedAmount(estimate.monthly_total)}</dd></div>
          <div><dt>Quoted annual recurring</dt><dd>{quotedAmount(estimate.annual_total)}</dd></div>
          <div><dt>Quoted one-time</dt><dd>{quotedAmount(estimate.onetime_total)}</dd></div>
        </dl>
        <div className="c360-estimate-applications">
          <h3 className="text-14 font-medium mb-2">Per application</h3>
          {(estimate.priceReferences || []).length > 0 ? <dl>
            {estimate.priceReferences.map((line, index) => <div key={index}>
              <dt>{line.name}</dt>
              <dd>{line.perApplicationPrice != null ? quotedAmount(line.perApplicationPrice)
                : line.monthlyPrice != null ? `${quotedAmount(line.monthlyPrice)} · billed monthly`
                  : "Not recorded"}</dd>
            </div>)}
          </dl> : <p className="text-14 text-ink-secondary">No per-application amount recorded.</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-14 text-ink-secondary">
          <span>{estimate.created_at ? formatETDate(estimate.created_at, { month: "short", day: "numeric", year: "numeric" }) : "No creation date"}</span>
          <a className={buttonStyles({ variant: "secondary", density: "comfortable", className: "" })} href={`/admin/estimates?estimateId=${encodeURIComponent(estimate.id)}`}>Open estimate<ArrowUpRight size={15} aria-hidden="true" /></a>
        </div>
      </Card>)}
      {matches.length === 0 && <Card className="p-5 text-14 text-ink-secondary">{query ? "No matching estimates." : "No estimates linked to this customer."}</Card>}
    </div>
  </section>;
}
