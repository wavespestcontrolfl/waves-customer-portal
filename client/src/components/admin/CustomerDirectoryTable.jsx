import CustomerHealthGrade from "./CustomerHealthGrade";
import { Fragment, useEffect, useRef } from "react";
import { ArrowDown, ArrowUp, MoreHorizontal, Phone, MessageSquare, PenLine, Trash2 } from "lucide-react";
import { Button, buttonStyles, Table, THead, TBody, TR, TH, TD } from "../ui";
import { formatETDateOnly } from "../../lib/timezone";

export default function CustomerDirectoryTable({ customers, onOpen, onEdit, onDelete, onCall, canEdit, sortBy, sortDir, onSort, editingId, editor }) {
  const root = useRef(null);
  useEffect(() => {
    let pointerTarget = null;
    const endPointer = () => { pointerTarget = null; };
    const closeOutside = (event) => {
      if (event.type === "pointerdown") pointerTarget = event.target;
      root.current?.querySelectorAll("details[open]").forEach((menu) => {
        // WebKit can focus a containing main element on mousedown instead of
        // the button. Keep the menu present until its pending click runs.
        if (event.type === "focusin" && menu.contains(pointerTarget)) return;
        if (!menu.contains(event.target)) menu.open = false;
      });
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    document.addEventListener("pointerup", endPointer);
    document.addEventListener("pointercancel", endPointer);
    document.addEventListener("keydown", endPointer);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      document.removeEventListener("pointerup", endPointer);
      document.removeEventListener("pointercancel", endPointer);
      document.removeEventListener("keydown", endPointer);
    };
  }, []);

  return <section ref={root} className="customer-directory-table" aria-label="Customer results">
    <Table layout="records" overflow="visible" className="table-fixed bg-white">
      <THead><TR>
        <TH aria-sort={sortBy === "lastName" ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
          <button type="button" onClick={() => onSort("lastName")} className="customer-directory-sort u-focus-ring">Customer{sortBy === "lastName" && (sortDir === "asc" ? <ArrowUp size={15} /> : <ArrowDown size={15} />)}</button>
        </TH>
        <TH>Property</TH><TH>WaveGuard Tier</TH><TH>Next service</TH><TH>Attention</TH><TH><span className="sr-only">Actions</span></TH>
      </TR></THead>
      <TBody>{customers.map((customer) => {
        const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ") || "Unnamed customer";
        const address = customer.address;
        const tier = ["Bronze", "Silver", "Gold", "Platinum"].find((label) => label.toLowerCase() === String(customer.tier || "").trim().toLowerCase());
        return <Fragment key={customer.id}>
          <TR className="customer-directory-record">
            <TD className="customer-directory-identity">
              <div className="flex items-center gap-2">
                <button type="button" className="customer-directory-name u-focus-ring" onClick={() => onOpen(customer.id)} aria-label={`Open ${name} customer profile`}>{name}</button>
                <CustomerHealthGrade score={customer.healthScore} />
              </div>
              {customer.profileLabel && customer.profileLabel !== "Primary" && <span>{customer.profileLabel}</span>}
            </TD>
            <TD data-label="Property" className="customer-directory-property">{address ? <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`} target="_blank" rel="noopener noreferrer" className="u-focus-ring">{address}</a> : "No address on file"}</TD>
            <TD data-label="WaveGuard Tier">{tier}</TD>
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
                <div className="ui-action-menu" onClick={(event) => {
                  if (event.target.closest("button,a")) {
                    const menu = event.currentTarget.closest("details"); menu.open = false;
                    menu.querySelector("summary")?.focus();
                  }
                }}>
                  {customer.phone && <>
                    <Button variant="ghost" className="ui-menu-action" onClick={() => onCall(customer)}><Phone size={16} />Call via Waves</Button>
                    <a href={`/admin/communications?phone=${encodeURIComponent(customer.phone)}`} className={buttonStyles({ variant: "ghost", density: "comfortable", className: "ui-menu-action" })}><MessageSquare size={16} />Messages</a>
                  </>}
                  {canEdit && <>
                    <Button variant="ghost" className="ui-menu-action" onClick={() => onEdit(customer)}><PenLine size={16} />Edit customer</Button>
                    <Button variant="ghost" className="ui-menu-action text-alert-fg" onClick={() => onDelete(customer.id, name)}><Trash2 size={16} />Delete customer</Button>
                  </>}
                  <Button variant="ghost" className="ui-menu-action" onClick={() => onOpen(customer.id)}>Open profile</Button>
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
