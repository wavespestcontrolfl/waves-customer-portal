import { useEffect, useId, useState } from "react";
import { ChevronLeft, ChevronRight, Filter, PanelLeft, Plus, Search, X } from "lucide-react";
import { Button, Dialog, Input, cn } from "../ui";
import useIsMobile from "../../hooks/useIsMobile";
import Customer360Profile from "./Customer360ProfileV2";

function CustomerDirectory({
  customers, selectedId, search, onSearch, loading, error, onRetry,
  total, page, totalPages, onPageChange, onSelect, onAdd, onFilters,
  activeFilterCount, stage, onStageChange, stages, onClose,
}) {
  const searchId = useId();
  return (
    <div className="c360-directory-content">
      <div className="flex items-center justify-between gap-2">
        <span className="text-14 text-ink-secondary">Customer directory</span>
        {onClose && <Button variant="ghost" className="c360-icon-button" aria-label="Close customer directory" onClick={onClose}><X size={18} /></Button>}
      </div>
      <div className="mb-5 mt-3 flex items-center justify-between gap-2">
        <h2 className="text-22 font-medium tracking-tight text-zinc-900">Customers <span className="ml-1 text-14 text-ink-secondary">{total}</span></h2>
        {onAdd && <Button variant="secondary" className="c360-icon-button" aria-label="Add customer" onClick={onAdd}><Plus size={18} /></Button>}
      </div>
      <label htmlFor={searchId} className="c360-directory-search">
        <Search size={17} aria-hidden="true" />
        <Input id={searchId} type="search" value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Find a customer…" aria-label="Find a customer" autoComplete="off" className="!pl-9 !text-16" />
      </label>
      <div className="my-3 flex items-center gap-2">
        <select aria-label="Customer status" value={stage} onChange={(event) => onStageChange(event.target.value)} className="c360-directory-stage">
          <option value="all">All customers</option>
          {stages.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
        <Button variant="ghost" className="c360-icon-button relative" aria-label={`Filter customers${activeFilterCount ? ` (${activeFilterCount} active)` : ""}`} onClick={onFilters}>
          <Filter size={17} />
          {activeFilterCount > 0 && <span className="c360-filter-count">{activeFilterCount}</span>}
        </Button>
      </div>
      <div className="c360-directory-list" aria-label="Customer results" aria-busy={loading}>
        {loading && <p role="status" className="p-3 text-14 text-ink-secondary">Loading customers…</p>}
        {error ? <div className="p-3 text-14"><p role="alert" className="mb-3 text-alert-fg">Could not load customers.</p><Button variant="secondary" onClick={onRetry}>Retry</Button></div> : customers.map((customer) => {
          const name = `${customer.firstName || ""} ${customer.lastName || ""}`.trim() || "Unnamed customer";
          const score = customer.healthScore;
          return <button key={customer.id} type="button" className={cn("c360-directory-row", String(customer.id) === String(selectedId) && "is-selected")} aria-current={String(customer.id) === String(selectedId) ? "true" : undefined} disabled={loading} onClick={() => onSelect(customer.id)}>
            <span className="c360-avatar c360-avatar-small" aria-hidden="true">{`${customer.firstName?.[0] || ""}${customer.lastName?.[0] || ""}` || "?"}</span>
            <span className="min-w-0 flex-1"><strong className="block truncate font-medium">{name}</strong><span className="mt-1 block truncate text-14 text-ink-secondary">{customer.city || customer.address?.city || customer.profileLabel || "No city on file"}</span></span>
            {score != null && <span className="c360-directory-health" style={{ backgroundColor: score >= 70 ? "#10B981" : score >= 40 ? "#F59E0B" : "#C8312F" }} aria-label={`Health: ${score} out of 100`} />}
          </button>;
        })}
        {!loading && !error && customers.length === 0 && <p className="p-3 text-14 text-ink-secondary">No matching customers.</p>}
      </div>
      {totalPages > 1 && <div className="c360-directory-pagination">
        <Button variant="ghost" className="c360-icon-button" aria-label="Previous results page" disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft size={18} /></Button>
        <span className="text-14 text-ink-secondary">{page} / {totalPages}</span>
        <Button variant="ghost" className="c360-icon-button" aria-label="Next results page" disabled={loading || page >= totalPages} onClick={() => onPageChange(page + 1)}><ChevronRight size={18} /></Button>
      </div>}
    </div>
  );
}

// The page owns the existing search/filter/pagination requests. This component
// only places those results beside the same profile used by the other routes.
export default function Customer360Workspace({ selectedId, onSelect, onClose, ...directoryProps }) {
  const compact = useIsMobile(1280);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const selectedIndex = directoryProps.customers.findIndex((item) => String(item.id) === String(selectedId));
  useEffect(() => { if (!compact) setDirectoryOpen(false); }, [compact]);
  const select = (id) => { setDirectoryOpen(false); onSelect(id); };
  const directory = <CustomerDirectory {...directoryProps} selectedId={selectedId} onSelect={select} onClose={compact ? () => setDirectoryOpen(false) : undefined} />;

  return <section className="c360-workspace" aria-label="Customer 360 workspace">
    {!compact && <aside className="c360-directory" aria-label="Customer directory">{directory}</aside>}
    <div className="c360-workspace-detail">
      <div className="c360-workspace-toolbar">
        {compact ? <Button variant="ghost" className="c360-directory-trigger" onClick={() => setDirectoryOpen(true)} aria-expanded={directoryOpen}><PanelLeft size={17} />Customers</Button> : <Button variant="ghost" className="c360-directory-trigger" onClick={onClose}><ChevronLeft size={17} />All customers</Button>}
        <span className="text-14 text-ink-secondary">Customer 360</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" className="c360-icon-button" aria-label="Previous customer" disabled={directoryProps.loading || selectedIndex <= 0} onClick={() => select(directoryProps.customers[selectedIndex - 1].id)}><ChevronLeft size={18} /></Button>
          <Button variant="ghost" className="c360-icon-button" aria-label="Next customer" disabled={directoryProps.loading || selectedIndex < 0 || selectedIndex >= directoryProps.customers.length - 1} onClick={() => select(directoryProps.customers[selectedIndex + 1].id)}><ChevronRight size={18} /></Button>
          {compact && <Button variant="ghost" className="c360-icon-button" aria-label="Close customer profile" onClick={onClose}><X size={18} /></Button>}
        </div>
      </div>
      <Customer360Profile key={selectedId} customerId={selectedId} onSelectCustomer={select} onClose={onClose} embedded />
    </div>
    <Dialog open={compact && directoryOpen} onClose={() => setDirectoryOpen(false)} size="sm" aria-label="Customer directory" className="admin-shell-v2 c360-directory-drawer" style={{ justifyContent: "flex-start", alignItems: "stretch", padding: 0, top: "var(--vv-offset-top, 0px)", bottom: "auto", height: "calc(var(--admin-vh, 100dvh) - var(--vv-offset-top, 0px))" }}>
      {directory}
    </Dialog>
  </section>;
}
