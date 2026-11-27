import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui";

// The Restock tab's Receive found that an invoice or delivery email already
// added this product's stock since the request was raised. The server refused
// the plain receive and sent its sentence ("An invoice already added <qty> on
// <date>. Receive again only if this is a second delivery."). The office either
// closes the request without touching stock (the usual case) or receives anyway.
export default function AlreadyCountedDialog({ request, message, busy, onCloseCounted, onReceiveAnyway, onClose }) {
  return (
    <Dialog open onClose={busy ? undefined : onClose} layer={400} aria-label="Stock already counted">
      <DialogHeader>
        <DialogTitle>Stock already counted</DialogTitle>
        <div className="text-ui-body text-ink-secondary">{request.productName}</div>
      </DialogHeader>
      <DialogBody className="space-y-3 text-ui-body text-zinc-900">
        <p className="m-0">{message}</p>
        <p className="m-0">Close, already counted ends this request and leaves the stock as it is.</p>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
          Back
        </Button>
        <Button type="button" variant="secondary" onClick={onReceiveAnyway} disabled={busy}>
          Receive anyway
        </Button>
        <Button type="button" variant="primary" onClick={onCloseCounted} disabled={busy}>
          Close, already counted
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
