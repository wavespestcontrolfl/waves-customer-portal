import { useEffect, useState } from "react";
import useLinkLibrary from "../../hooks/useLinkLibrary";
import { STATIC_COMPOSER_LINKS, libraryLinkClause } from "../../lib/composerLinks";
import { HOW_TO_CAPTION, HOW_TO_GUIDE_LINKS } from "../../lib/howToGuides";
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
    // Only the public library, login and how-to links enter this draft; guide delivery
    // remains the existing send-prep action inside the shared sheet.
    const url = /^https?:\/\//i.test(link.url) ? link.url : `https://${link.url}`;
    const resolved = { ...link, url };
    // A how-to guide also offers its title as the subject of a new email.
    const guide = Array.isArray(link.steps) ? resolved : null;
    onInsert({ url, clause: libraryLinkClause(resolved), guide, subject: guide ? guide.title : null });
    setOpen(false);
  };

  return <>
    <Button variant="secondary" disabled={disabled} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setOpen(true); }}
      aria-haspopup="dialog" aria-expanded={active && open}>Quick Links</Button>
    <InsertLinkSheet open={active && open} onClose={() => setOpen(false)}
      layer={1100} links={[...STATIC_COMPOSER_LINKS, ...HOW_TO_GUIDE_LINKS, ...(library.links || [])]}
      loading={library.loading} error={library.error} onRetry={library.retry}
      recipientSearch={recipient} prepChannel="email" onPick={pick}
      groupCaptions={{ customer: "Account links open after the customer signs in.", howto: HOW_TO_CAPTION }} />
  </>;
}
