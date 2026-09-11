import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Sheet, SheetHeader, SheetBody } from '../ui/Sheet';
import { cn } from '../ui/cn';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import PrepGuideForm, { PREP_GUIDE_LINKS } from './PrepGuideForm';

// The composers' Quick Links picker: one searchable sheet over links and prep
// guides. The SMS composer supplies its per-customer minted links (reschedule,
// re-service, review request, pay balance, latest estimate, referral, Auto
// Pay setup), the per-office Google review links, and the whole link library
// (sitemap-synced website pages + hand-managed rows). Presentation only: the
// parent owns the library fetch and what happens when a row is picked.
//
// Rows flagged `channels` (the review request) ask Text / Email / Both before
// firing onPick(link, channel) — owner ruling 2026-09-03: a review ask goes
// out by text, by email, or both, the operator's choice.

export const LINK_CHANNELS = [
  ["sms", "Text", "Puts the link in this message"],
  ["email", "Email", "Sends the review email now"],
  ["both", "Both", "Link here, and the email goes out when you send"],
];

export const LINK_GROUP_ORDER = [
  ['customer', 'For this customer'],
  ['guides', 'Prep guides'],
  ['reviews', 'Reviews'],
  ['booking', 'Booking & quotes'],
  ['app', 'Waves app'],
  ['website', 'Website'],
  ['social', 'Social'],
];
const GROUP_LABELS = Object.fromEntries(LINK_GROUP_ORDER);

// Case-insensitive AND-match across name, url, keywords, and the group label,
// mirroring how the rest of the admin searches behave: every whitespace-
// separated term must hit somewhere. Exported for tests.
export function linkMatchesQuery(link, query) {
  const terms = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [link.name, link.url, link.keywords, GROUP_LABELS[link.category] || link.category]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// Group + filter a flat link list into ordered render groups. Exported for tests.
export function buildLinkGroups(links, query, activeCategory) {
  const groups = [];
  for (const [key, label] of LINK_GROUP_ORDER) {
    if (activeCategory !== "all" && activeCategory !== key) continue;
    const rows = (links || []).filter(
      (l) => l.category === key && linkMatchesQuery(l, query),
    );
    if (rows.length) groups.push({ key, label, rows });
  }
  return groups;
}

const displayUrl = (url) => String(url || "").replace(/^https?:\/\//, "");

const ICONS = {
  customer: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  reviews: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  ),
  link: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
};

export default function InsertLinkSheet({
  open,
  onClose,
  links,
  loading = false,
  error = null,
  onRetry,
  busyKey = null,
  onPick,
  groupCaptions = {},
  recipientSearch = "",
  prepChannel = "both",
  layer = 120,
}) {
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  // The `channels` row whose Text / Email / Both chooser is open.
  const [channelRowKey, setChannelRowKey] = useState(null);
  const [prepGuide, setPrepGuide] = useState(null);
  const [prepSending, setPrepSending] = useState(false);
  const searchRef = useRef(null);

  // Fresh search each open — a stale filter from the last insert is never
  // what the operator wants for the next one.
  useEffect(() => {
    if (open && !prepGuide) {
      setQuery("");
      setActiveCategory("all");
      setChannelRowKey(null);
    }
  }, [open]);

  // The list remounts after Back; focus only after its input exists.
  useEffect(() => {
    if (!open || prepGuide) return undefined;
    const t = setTimeout(() => searchRef.current?.focus({ preventScroll: true }), 60);
    return () => clearTimeout(t);
  }, [open, prepGuide]);

  const groups = useMemo(
    () => buildLinkGroups([...(links || []), ...PREP_GUIDE_LINKS], query, activeCategory),
    [links, query, activeCategory],
  );
  const hasQuery = Boolean(query.trim());
  const close = () => {
    if (prepSending) return;
    setPrepGuide(null);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} width="sm" ariaLabel="Quick Links" layer={layer} keepMounted={!!prepGuide}>
      <SheetHeader>
        <span className="text-14 font-medium text-zinc-900">Quick Links</span>
        <Button
          variant="ghost"
          onClick={close}
          disabled={prepSending}
          aria-label="Close"
          className="ui-icon-action"
        >
          <span aria-hidden>✕</span>
        </Button>
      </SheetHeader>
      {prepGuide ? (
        <SheetBody>
          <Button variant="ghost" disabled={prepSending}
            onClick={() => setPrepGuide(null)}
            className="mb-4">
            Back to Quick Links
          </Button>
          <PrepGuideForm active={open} guide={prepGuide} initialSearch={recipientSearch}
            initialChannel={prepChannel} onSendingChange={setPrepSending} />
        </SheetBody>
      ) : <>
      <div className="px-5 pt-3 pb-2 border-b border-hairline border-zinc-200 shrink-0">
        <div className="relative">
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" />
          </svg>
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search links — try 'termite', 'pay', 'review'…"
            autoComplete="off"
            aria-label="Search links"
            className={cn(
              "w-full h-11 bg-white border-hairline border-zinc-300 rounded-sm",
              "text-16 text-zinc-900 pl-9 pr-3",
              "focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900",
            )}
          />
        </div>
        <div className="flex gap-1.5 overflow-x-auto py-2.5 [scrollbar-width:none]">
          {[["all", "All"], ...LINK_GROUP_ORDER].map(([key, label]) => (
            <Button
              key={key}
              variant={activeCategory === key ? "primary" : "secondary"}
              aria-pressed={activeCategory === key}
              onClick={() => setActiveCategory(key)}
              className="shrink-0 rounded-full"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      <SheetBody className="p-0">
        {/* Groups render from whatever links the parent passed — the
            customer rows are local config, so a library fetch that is still
            loading (or failed) must never take the reschedule/re-service
            inserts down with it. The library's own state renders below. */}
        {groups.map(({ key, label, rows }) => (
            <div key={key}>
              <div className="px-5 pt-3.5 pb-1 text-ui-label font-medium text-ink-secondary">
                {label}
              </div>
              {!hasQuery && groupCaptions[key] && (
                <div className="px-5 pb-2 text-ui-caption text-ink-secondary leading-normal">
                  {groupCaptions[key]}
                </div>
              )}
              {rows.map((link) => {
                const busy = busyKey != null && busyKey === link.key;
                const chooserOpen = link.channels && channelRowKey === link.key;
                return (
                  <div key={link.key}>
                  <button
                    type="button"
                    onClick={() => (link.pestType
                      ? setPrepGuide(link)
                      : link.channels
                      ? setChannelRowKey(chooserOpen ? null : link.key)
                      : onPick(link))}
                    disabled={busyKey != null}
                    title={link.title || link.name}
                    aria-expanded={link.channels ? chooserOpen : undefined}
                    className={cn(
                      "w-full min-h-11 appearance-none border-0 bg-white flex items-center gap-3 text-left px-5 py-3 text-ui-body u-focus-ring",
                      "hover:bg-zinc-50 disabled:opacity-60",
                      chooserOpen && "bg-zinc-50",
                    )}
                  >
                    <span className="shrink-0 w-8 h-8 rounded-sm bg-zinc-100 text-zinc-700 grid place-items-center">
                      {ICONS[link.category === "customer" ? "customer" : link.category === "reviews" ? "reviews" : "link"]}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-ui-body font-medium text-zinc-900 truncate">{link.name}</span>
                      <span className="block text-ui-caption text-ink-secondary truncate">
                        {link.description || displayUrl(link.url) || "Personal link — looked up on insert"}
                      </span>
                    </span>
                    {busy ? (
                      <Badge tone="neutral" className="shrink-0">
                        Adding…
                      </Badge>
                    ) : link.dynamic ? (
                      <Badge tone="strong" className="shrink-0">
                        This customer
                      </Badge>
                    ) : null}
                  </button>
                  {chooserOpen && (
                    <div className="px-5 pb-3 pl-16 flex flex-col gap-1.5" role="group" aria-label={`Send ${link.name} by`}>
                      {LINK_CHANNELS.map(([value, label, hint]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => onPick(link, value)}
                          disabled={busyKey != null}
                          className={cn(
                            "flex min-h-11 items-baseline gap-2 text-left rounded-sm px-3 py-2 border-hairline border-zinc-300 bg-white text-ui-body u-focus-ring",
                            "hover:bg-zinc-100 disabled:opacity-60",
                          )}
                        >
                          <span className="text-ui-body font-medium text-zinc-900 w-11 shrink-0">{label}</span>
                          <span className="text-ui-caption text-ink-secondary">{hint}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          ))}
        {loading && (
          <div className="px-5 py-4 text-ui-body text-ink-secondary">Loading the link library…</div>
        )}
        {!loading && error && (
          <div className="px-5 py-4 text-ui-body">
            <span className="text-alert-fg">{error}</span>{" "}
            {onRetry && (
              <Button variant="ghost" onClick={onRetry} className="underline">
                Retry
              </Button>
            )}
          </div>
        )}
        {!loading && !error && !groups.length && (
          <div className="px-5 py-6 text-ui-body text-ink-secondary leading-relaxed">
            No links match &ldquo;{query.trim()}&rdquo;.
            <br />
            Add it under Settings &rsaquo; Link Library and it shows up here.
          </div>
        )}
      </SheetBody>
      </>}
    </Sheet>
  );
}
