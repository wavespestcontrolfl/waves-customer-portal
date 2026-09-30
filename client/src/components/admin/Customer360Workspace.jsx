import { useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "../ui";
import Customer360Profile from "./Customer360ProfileV2";
import { confirmDiscardDraft } from "./CustomerGeocodeReviewPanel";

// The directory stays mounted in the page so returning preserves its filters.
// The record uses the admin shell's full content width.
export default function Customer360Workspace({ selectedId, initialTab, onSelect, onClose, onCustomerMutation, onDraftActiveChange }) {
  // Lifted from the embedded profile's address-review panel: "All customers"
  // is a sibling control, outside the profile's own subtree, so it cannot see
  // the profile's local draft-active ref directly and needs its own copy.
  const [draftActive, setDraftActive] = useState(false);
  // Also forwarded to the owning page (CustomersPageV2) so its own
  // browser Back/Forward guard sees the same signal — same choke point,
  // one more subscriber.
  const handleDraftActiveChange = (active) => {
    setDraftActive(active);
    onDraftActiveChange?.(active);
  };
  return <section className="c360-workspace" aria-label="Customer 360 workspace">
    <div className="c360-workspace-detail">
      <div className="c360-workspace-toolbar">
        <Button variant="secondary" className="c360-directory-trigger" onClick={() => {
          if (draftActive && !confirmDiscardDraft()) return;
          onClose();
        }}><ChevronLeft size={17} />All customers</Button>
      </div>
      <Customer360Profile key={selectedId} customerId={selectedId} initialTab={initialTab} onSelectCustomer={onSelect} onClose={onClose} onCustomerMutation={onCustomerMutation} onDraftActiveChange={handleDraftActiveChange} embedded />
    </div>
  </section>;
}
