import { ChevronLeft } from "lucide-react";
import { Button } from "../ui";
import Customer360Profile from "./Customer360ProfileV2";

// The directory stays mounted in the page so returning preserves its filters.
// The record uses the admin shell's full content width.
export default function Customer360Workspace({ selectedId, initialTab, onSelect, onClose }) {
  return <section className="c360-workspace" aria-label="Customer 360 workspace">
    <div className="c360-workspace-detail">
      <div className="c360-workspace-toolbar">
        <Button variant="secondary" className="c360-directory-trigger" onClick={onClose}><ChevronLeft size={17} />All customers</Button>
      </div>
      <Customer360Profile key={selectedId} customerId={selectedId} initialTab={initialTab} onSelectCustomer={onSelect} onClose={onClose} embedded />
    </div>
  </section>;
}
