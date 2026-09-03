// Shared fixture for the Models tab tests: the GET /admin/agents/models shape
// with two selectors and five lanes that cover every migration-set group.
const text = (providers, deep = false) => ({ providers, cap: "text", deep });

export const CATALOG = {
  m1: { label: "Claude Opus 4.8", provider: "anthropic", caps: [], status: "current" },
  m2: { label: "Claude Opus 5", provider: "anthropic", caps: [], status: "current" },
  m3: { label: "GPT-5.6 Terra", provider: "openai", caps: [], status: "current" },
  m4: { label: "GPT-5.6 Luna", provider: "openai", caps: [], status: "current" },
};

export const AREAS = [
  { key: "sms", label: "SMS & messaging", description: "Texts customers read" },
  { key: "ib", label: "Intelligence Bar", description: "The command bar" },
  { key: "reports", label: "Service reports", description: "After a visit" },
  { key: "office", label: "Back office", description: "Books and audits" },
];

const onSelector = (selector, model) => ({ model, selector, pinEnv: null, pinned: false, unpinnedModel: model, accepts: text(["anthropic"]), live: false });
const pinned = (pinEnv, model, accepts = text(["anthropic"])) => ({ model, selector: "FLAGSHIP", pinEnv, pinned: true, unpinnedModel: "m1", accepts, live: false });

export function makeData() {
  return {
    models: { ...CATALOG },
    areas: AREAS.map((a) => ({ ...a })),
    selectors: [
      { key: "FLAGSHIP", env: "MODEL_FLAGSHIP", current: "m1", derived: false, derivesFrom: null, lock: null, overridden: false, codeDefault: "m1", accepts: text(["anthropic"]) },
      { key: "OPENAI_FAST", env: "MODEL_OPENAI_FAST", current: "m4", derived: false, derivesFrom: null, lock: null, overridden: false, codeDefault: "m4", accepts: text(["openai"]) },
    ],
    lanes: [
      { id: "sms_intent", name: "SMS intent", describe: "Works out what a text asks for", area: "sms", continuity: "verified", inbound: false, lock: null, fanout: false, applies: "restart", primary: onSelector("FLAGSHIP", "m1"), fallback: onSelector("OPENAI_FAST", "m4"), retry: null, also: [] },
      { id: "sms_draft", name: "SMS draft", describe: "Drafts a reply", area: "sms", continuity: "judged", inbound: true, lock: null, fanout: false, applies: "restart", primary: onSelector("FLAGSHIP", "m1"), fallback: null, retry: null, also: [] },
      { id: "ib_admin", name: "Intelligence Bar", describe: "Answers the admin", area: "ib", continuity: "unchecked", inbound: false, lock: null, fanout: false, applies: "restart", primary: pinned("PIN_IB", "m1"), fallback: onSelector("OPENAI_FAST", "m4"), retry: null, also: [] },
      { id: "report_copy", name: "Report copy", describe: "Writes the visit report", area: "reports", continuity: "verified", inbound: false, lock: null, fanout: false, applies: "restart", primary: pinned("PIN_REPORT", "m1", text(["anthropic", "openai"])), fallback: null, retry: null, also: [] },
      { id: "audit_deep", name: "Deep audit", describe: "Audits the books", area: "office", continuity: "verified", inbound: false, lock: { label: "Bake-off", detail: "pinned by ruling" }, fanout: false, applies: "restart", primary: onSelector("FLAGSHIP", "m1"), fallback: null, retry: null, also: [] },
    ],
  };
}
