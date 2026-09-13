import { useEffect, useState } from "react";
import useLinkLibrary from "../../hooks/useLinkLibrary";
import { STATIC_COMPOSER_LINKS, libraryLinkClause } from "../../lib/composerLinks";
import { Button } from "../ui/Button";
import InsertLinkSheet from "./InsertLinkSheet";

export default function EmailQuickLinks({ active, recipient, disabled, onInsert }) {
  const [open, setOpen] = useState(false);
  const library = useLinkLibrary(active && open);
  useEffect(() => {
    setOpen(false);
  }, [active, recipient]);

  const pick = (link) => {
    // The email send endpoint does not own SMS bearer activation/consent.
    // Only the public library and login links enter this draft; guide delivery
    // remains the existing send-prep action inside the shared sheet.
    const url = /^https?:\/\//i.test(link.url) ? link.url : `https://${link.url}`;
    onInsert({ url, clause: libraryLinkClause({ ...link, url }) });
    setOpen(false);
  };

  return <>
    <Button variant="secondary" disabled={disabled} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}
      aria-haspopup="dialog" aria-expanded={active && open}>Quick Links</Button>
    <InsertLinkSheet open={active && open} onClose={() => setOpen(false)}
      layer={1100} links={[...STATIC_COMPOSER_LINKS, ...(library.links || [])]}
      loading={library.loading} error={library.error} onRetry={library.retry}
      recipientSearch={recipient} prepChannel="email" onPick={pick}
      groupCaptions={{ customer: "Account links open after the customer signs in." }} />
  </>;
}
