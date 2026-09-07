import { Fragment, useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal, Phone, MessageSquare, PenLine, Trash2 } from "lucide-react";
import { Button, Table, THead, TBody, TR, TH, TD } from "../ui";
import { formatETDateOnly } from "../../lib/timezone";

export default function CustomerDirectoryTable({ customers, onOpen, onEdit, onDelete, onCall, canEdit, sortBy, sortDir, onSort, editingId, editor }) {
  const root = useRef(null);
  useEffect(() => {
    const closeOutside = (event) => {
      root.current?.querySelectorAll("details[open]").forEach((menu) => {
        if (!menu.contains(event.target)) menu.open = false;
      });
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, []);

  return <section ref={root} className="customer-directory-table" aria-label="Customer results">
    <Table>
      <THead><TR>
        <TH aria-sort={sortBy === "lastName" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
          <button type="button" onClick={() => onSort("lastName")} className="customer-directory-sort u-focus-ring">Customer{sortBy === "lastName" && (sortDir === "asc" ? <ArrowUp size={15} /> : <ArrowDown size={15} />)}</button>
        </TH>
        <TH>Property</TH><TH>Services on record</TH><TH>Next service</TH><TH>Attention</TH><TH><span className="sr-only">Actions</span></TH>
      </TR></THead>
      <TBody>{customers.map((customer) => {
        const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "Unnamed customer";
        const address = customer.address;
        const serviceNames = String(customer.serviceTypes || "").split(",").map((item) => item.trim()).filter(Boolean);
        return <Fragment key={customer.id}>
          <TR className="customer-directory-record">
            <TD className="customer-directory-identity">
              <button type="button" className="customer-directory-name u-focus-ring" onClick={() => onOpen(customer.id)} aria-label={`Open ${name} customer profile`}>{name}</button>
              <span>{customer.email || customer.phone || "No contact on file"}</span>
              {customer.profileLabel && customer.profileLabel !== "Primary" && <span>{customer.profileLabel}</span>}
            </TD>
            <TD data-label="Property" className="customer-directory-property">{address ? <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`} target="_blank" rel="noopener noreferrer" className="u-focus-ring">{address}</a> : "No address on file"}</TD>
            <TD data-label="Services on record">{serviceNames.length ? serviceNames.join(", ") : "No service history"}</TD>
            <TD data-label="Next service">{customer.nextServiceDate ? formatETDateOnly(customer.nextServiceDate, { month: "short", day: "numeric" }) : "Not scheduled"}</TD>
            <TD data-label="Attention" className="customer-directory-attention">
              {customer.overdueInvoiceCount > 0 && <span className="text-alert-fg">{customer.overdueInvoiceCount} overdue invoice{customer.overdueInvoiceCount === 1 ? "" : "s"}</span>}
              {!(customer.overdueInvoiceCount > 0) && <span>—</span>}
            </TD>
            <TD className="customer-directory-actions">
              <details onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault(); event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                }
              }}>
                <summary aria-label={`Actions for ${name}`}><MoreHorizontal size={20} /></summary>
                <div className="customer-directory-menu" onClick={(event) => {
                  if (event.target.closest("button,a")) {
                    const menu = event.currentTarget.closest("details"); menu.open = false;
                    menu.querySelector("summary")?.focus();
                  }
                }}>
                  {customer.phone && <>
                    <Button variant="secondary" onClick={() => onCall(customer)}><Phone size={16} />Call via Waves</Button>
                    <a href={`/admin/communications?phone=${encodeURIComponent(customer.phone)}`} className="u-focus-ring"><MessageSquare size={16} />Messages</a>
                  </>}
                  {canEdit && <>
                    <Button variant="secondary" onClick={() => onEdit(customer)}><PenLine size={16} />Edit customer</Button>
                    <Button variant="secondary" className="text-alert-fg" onClick={() => onDelete(customer.id, name)}><Trash2 size={16} />Delete customer</Button>
                  </>}
                  <Button variant="secondary" onClick={() => onOpen(customer.id)}>Open profile</Button>
                </div>
              </details>
            </TD>
          </TR>
          {editingId === customer.id && <TR className="customer-directory-editor"><TD colSpan={6}>{editor}</TD></TR>}
        </Fragment>;
      })}</TBody>
    </Table>
  </section>;
}
