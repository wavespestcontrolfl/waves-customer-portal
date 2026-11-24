import { useState } from "react";
import { cn } from "../ui";

// Photo thumbnails inside a message: SMS attachments in Communications, and
// a customer's photos in a portal thread (PortalInboxTabV2).
export function MessageMediaV2({ media = [], inverted = false }) {
  // A signed media URL that fails to load (expired signature, offline) left a
  // blank image box inside the bubble — on an outbound (dark) bubble that
  // reads as a big empty black rectangle. Swap failed loads for a labeled
  // chip that still links to the attachment.
  const [failed, setFailed] = useState({});
  const items = Array.isArray(media) ? media.filter((m) => m?.url) : [];
  if (!items.length) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-1.5">
      {items.map((item, idx) => (
        <a
          key={item.key || item.url || idx}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "block overflow-hidden rounded-sm border-hairline u-focus-ring",
            inverted
              ? "border-white/30 bg-white/10"
              : "border-zinc-300 bg-white",
          )}
        >
          {" "}
          {failed[item.url] ? (
            <span
              className={cn(
                "flex items-center justify-center h-12 px-2 text-14",
                inverted ? "text-white/80" : "text-ink-secondary",
              )}
            >
              {item.fileName || "Attachment"}
            </span>
          ) : (
            <img
              src={item.url}
              alt={item.fileName || `Attachment ${idx + 1}`}
              className="h-28 w-full object-cover"
              loading="lazy"
              onError={() =>
                setFailed((f) => ({ ...f, [item.url]: true }))
              }
            />
          )}{" "}
        </a>
      ))}
    </div>
  );
}
