import { useState } from "react";
import { ThumbsUp } from "lucide-react";
import { Badge, Button } from "../ui";
import { formatETTime } from "../../lib/timezone";
import { sendOfficeLike } from "../../lib/smsLikes";

// GATE_SMS_LIKE (owner 2026-11-02, "SMS Like Button"): the like button under a
// customer's newest text, the badge that shows who liked it, and the badges for
// customer likes on our texts. Used by Messages and the Customer 360 thread.

// A click texts a thumbs-up to the customer (the server's like route), so the
// button says so. onLiked(messageId, officeLike) runs after the send.
export function OfficeLikeButton({ messageId, customerName, onLiked }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const like = async () => {
    if (sending) return;
    setSending(true);
    setError("");
    try {
      const result = await sendOfficeLike(messageId);
      onLiked?.(messageId, result?.officeLike || null);
    } catch (e) {
      setError(e?.message || "The like was not sent.");
    } finally {
      setSending(false);
    }
  };
  const label = `Text a thumbs-up to ${customerName || "this customer"}`;
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="sm" variant="secondary" onClick={like} disabled={sending} title={label} aria-label={label}>
        <ThumbsUp size={13} strokeWidth={1.75} className="mr-1.5" aria-hidden />
        {sending ? "Sending..." : "Like"}
      </Button>
      {error ? <span role="alert" className="text-ui-body text-alert-fg">{error}</span> : null}
    </div>
  );
}

// Who liked the customer's text, and when. "Not confirmed": the thumbs-up may
// not have reached the customer, and the text cannot get a second like.
export function OfficeLikeBadge({ like }) {
  if (!like) return null;
  const confirmed = like.status === "sent";
  const parts = [like.by || "Office", like.at ? formatETTime(like.at) : null, confirmed ? null : "not confirmed"].filter(Boolean);
  return (
    <Badge tone={confirmed ? "neutral" : "warn"} title={confirmed ? "Thumbs-up texted to the customer" : "The thumbs-up may not have reached the customer"}>
      <ThumbsUp size={12} strokeWidth={1.75} aria-hidden />
      {parts.join(" · ")}
    </Badge>
  );
}

// The like badges a bubble shows: who liked a customer's text, or the
// customer's likes on ours (badges: the map from smsLikeThread, keyed by id).
export function SmsLikeBadges({ message, badges }) {
  if (message?.direction === "inbound") return <OfficeLikeBadge like={message.officeLike} />;
  return <CustomerReactionBadges badges={badges?.get(message?.id)} />;
}

// The customer's likes on one of our texts (collapseCustomerReactions). The
// emoji is the customer's own, from the message data.
export function CustomerReactionBadges({ badges }) {
  if (!badges?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge key={b.id} tone="neutral" title="The customer reacted to this text">
          {b.emoji}
        </Badge>
      ))}
    </span>
  );
}
