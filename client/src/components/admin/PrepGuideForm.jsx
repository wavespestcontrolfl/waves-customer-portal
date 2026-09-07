import { useEffect, useId, useRef, useState } from "react";
import { adminFetch } from "../../lib/adminFetch";
import { Button } from "../ui/Button";
import { Radio } from "../ui/Radio";

// The existing manual sender's live guide list (PREP_CONFIG in prep-guide-sender).
// These are delivery actions, not public URLs to insert into a draft.
export const PREP_GUIDE_LINKS = [
  ["flea", "Flea treatment", "flea infestation"],
  ["bed_bug", "Bed bug treatment", "bedbug mattress"],
  ["cockroach", "Cockroach treatment", "roach german"],
  ["interior_pest", "Interior pest treatment", "indoor pest control"],
  ["rodent", "Rodent service", "rat mouse mice"],
  ["termite", "Termite service", "termite"],
  ["mosquito", "Mosquito treatment", "mosquito yard"],
  ["lawn", "Lawn treatment", "grass turf watering"],
  ["sprinkler_timer", "Sprinkler timer guide (lawn)", "irrigation controller watering seasonal tips"],
].map(([pestType, name, keywords]) => ({
  key: `prep:${pestType}`, pestType, name, category: "guides",
  keywords: `prep prepare preparation checklist guide email text ${keywords}`,
  description: "Send by email, text, or both",
}));

const CHANNELS = [
  { value: "both", label: "Email and text", action: "Send email and text" },
  { value: "email", label: "Email only", action: "Send by email" },
  { value: "sms", label: "Text only", action: "Send by text" },
];

function customerName(customer) {
  return [customer.firstName || customer.first_name, customer.lastName || customer.last_name]
    .filter(Boolean).join(" ") || customer.name || customer.phone || "Customer";
}

export default function PrepGuideForm({ active, guide, initialSearch = "", initialChannel = "both", onSendingChange }) {
  const formId = useId();
  const [channel, setChannel] = useState(initialChannel);
  const [search, setSearch] = useState(initialSearch);
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const sendInFlight = useRef(false);

  useEffect(() => {
    if (!active || selected || search.trim().length < 2) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return undefined;
    }
    let cancelled = false;
    setResults([]);
    setSearching(true);
    setSearchError(null);
    const timer = setTimeout(async () => {
      try {
        const response = await adminFetch(`/admin/customers?search=${encodeURIComponent(search.trim())}&limit=8`);
        if (!response.ok) throw new Error("Couldn't search customers. Try again.");
        const data = await response.json();
        if (!cancelled) setResults(data.customers || []);
      } catch (err) {
        if (!cancelled) setSearchError(err.message);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, search, selected]);

  const handleSend = async (event) => {
    event.preventDefault();
    if (!selected || sendInFlight.current) return;
    sendInFlight.current = true;
    setSending(true);
    onSendingChange(true);
    setResult(null);
    try {
      const response = await adminFetch("/admin/communications/send-prep", {
        method: "POST",
        body: { customerId: selected.id, pestType: guide.pestType, channel },
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || "Couldn't confirm guide delivery.");
      setResult({ ok: !data.partial, text: data.message || "Guide sent." });
    } catch (err) {
      setResult({ ok: false, text: err.message || "Couldn't confirm guide delivery. Check the customer's delivery history." });
    } finally {
      sendInFlight.current = false;
      setSending(false);
      onSendingChange(false);
    }
  };

  return (
    <form onSubmit={handleSend} className="space-y-4 text-14 text-zinc-900 [&_label]:text-14">
      <div>
        <h2 className="text-16 font-medium mb-2">{guide.name}</h2>
        <p className="text-zinc-600 leading-relaxed">
          {guide.pestType === "sprinkler_timer"
            ? "A one-time seasonal tip for recurring lawn customers. The text carries the website guide link and needs no visit. Seasonal Lawn Tips preferences apply."
            : "Email sends the full guide. Text uses the upcoming visit's guide link when available; some guides need a matching visit to be texted."}
        </p>
      </div>
      <fieldset disabled={sending} className="space-y-3 min-w-0 border-0 p-0 m-0">
        <legend className="font-medium mb-2 p-0">Customer</legend>
        {selected ? (
          <div className="border-hairline border-zinc-200 rounded-sm px-3 py-3">
            <div className="font-medium break-words">{customerName(selected)}</div>
            <div className="text-zinc-600 break-all">{selected.email || "No email on file"}</div>
            <div className="text-zinc-600">{selected.phone || "No phone on file"}</div>
            <Button size="sm" variant="ghost" className="mt-2 text-14" onClick={() => {
              setSelected(null); setSearch(""); setResult(null);
            }}>Change customer</Button>
          </div>
        ) : (
          <>
            <input
              autoFocus
              aria-label="Search customer"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setResult(null); }}
              placeholder="Search by name, email, or phone…"
              className="w-full h-11 px-3 rounded-sm border-hairline border-zinc-300 text-16 bg-white u-focus-ring"
            />
            {searching && <p role="status" className="text-zinc-600">Searching…</p>}
            {searchError && <p role="alert" className="text-alert-fg">{searchError}</p>}
            {!searching && !searchError && search.trim().length >= 2 && !results.length && (
              <p className="text-zinc-600">No customers found.</p>
            )}
            <div className="empty:hidden border-hairline border-zinc-200 rounded-sm divide-y divide-zinc-100 max-h-60 overflow-y-auto">
              {results.map((customer) => (
                <button key={customer.id} type="button" className="w-full text-left px-3 py-3 border-0 bg-transparent hover:bg-zinc-50 u-focus-ring"
                  onClick={() => { setSelected(customer); setResults([]); setResult(null); }}>
                  <span className="block font-medium">{customerName(customer)}</span>
                  <span className="block text-zinc-600 break-all">{customer.email || "No email"}</span>
                  <span className="block text-zinc-600">{customer.phone || "No phone"}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </fieldset>
      <fieldset disabled={sending} className="flex flex-col gap-3 min-w-0 border-0 p-0 m-0">
        <legend className="font-medium mb-2 p-0">Send by</legend>
        {CHANNELS.map((choice) => (
          <Radio key={choice.value} id={`${formId}-prep-${choice.value}`} name={`${formId}-prep-channel`}
            label={choice.label} checked={channel === choice.value} disabled={sending}
            onChange={() => { setChannel(choice.value); setResult(null); }} />
        ))}
      </fieldset>
      <p className="text-zinc-600 leading-relaxed">This sends the guide separately. Your message draft stays as written.</p>
      {result && <p role={result.ok ? "status" : "alert"} className={result.ok ? "text-zinc-900" : "text-alert-fg"}>{result.text}</p>}
      <Button type="submit" className="w-full text-14" disabled={!selected || sending || result?.ok}>
        {sending ? "Sending…" : CHANNELS.find((choice) => choice.value === channel).action}
      </Button>
    </form>
  );
}
