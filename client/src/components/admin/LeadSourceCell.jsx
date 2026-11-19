import {
  HelpCircle, Globe2, Link2, Mail, MapPin, Megaphone,
  MousePointer2, Search, Sparkles, Users,
} from "lucide-react";
import googleAds from "../../assets/lead-sources/google-ads.png";
import googleBusiness from "../../assets/lead-sources/google-business-profile.png";
import chatgpt from "../../assets/lead-sources/chatgpt.png";
import copilot from "../../assets/lead-sources/copilot.png";

const marks = { google_ads: googleAds, google_business: googleBusiness, chatgpt, copilot };
const icons = {
  meta_ads: Megaphone, organic_search: Search, organic_social: Users,
  direct: MousePointer2, website: Globe2, offline: MapPin, referral: Link2,
  email: Mail, other_ai: Sparkles, ai_referral: Sparkles,
};
const unavailable = { kind: "unknown", label: "Source unknown", detail: "No verified source on file" };

export default function LeadSourceCell({ evidence, legacySource }) {
  const source = evidence || (legacySource
    ? { kind: "unknown", label: legacySource, detail: "Recorded CRM source" }
    : unavailable);
  const mark = marks[source.kind];
  const Icon = icons[source.kind] || HelpCircle;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-50 text-zinc-600">
        {mark
          ? <img src={mark} alt="" width="26" height="26" className="h-[26px] w-[26px] object-contain" />
          : <Icon size={18} strokeWidth={1.7} />}
      </span>
      <span className="min-w-0 text-14 leading-snug">
        <span className="block font-medium text-ink-primary">{source.label}</span>
        {source.detail && <span className="block text-ink-secondary">{source.detail}</span>}
      </span>
    </span>
  );
}
