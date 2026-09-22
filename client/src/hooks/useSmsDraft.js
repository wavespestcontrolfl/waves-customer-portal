import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

export const SMS_DRAFT_STORAGE_KEY = "waves_admin_sms_drafts_v1";
export const SMS_DRAFT_RECOVERY_WARNING =
  "This SMS draft is only available in this tab. Copy it before reloading or closing the tab.";

const DRAFT_FIELDS = [
  "msgBody",
  "attachments",
  "insertedResched",
  "insertedReservice",
  "insertedCustomerLinks",
  "loadedMessageDraft",
  "selectedAgentDraft",
  "replyContext",
  "sendTiming",
  "sendCustomAt",
  "fromNumber",
  "selectedCustomerId",
  "threadLock",
];

const emptyDraft = () => ({
  msgBody: "",
  attachments: [],
  insertedResched: null,
  insertedReservice: null,
  insertedCustomerLinks: {},
  loadedMessageDraft: null,
  selectedAgentDraft: null,
  replyContext: null,
  sendTiming: "now",
  sendCustomAt: "",
  fromNumber: "",
  selectedCustomerId: null,
  threadLock: null,
});

// Owner-backed drafts survive route remounts even when sessionStorage is
// temporarily unavailable. Drafts without an owner remain private to one hook
// instance, which keeps synthetic/test contexts from sharing account data.
const ownerMemory = new Map();

function createStore() {
  return { entries: new Map(), listeners: new Map() };
}

function ownerKey(ownerId) {
  if (ownerId === null || ownerId === undefined || String(ownerId).trim() === "") return null;
  return String(ownerId);
}

function recipientKeyValue(recipientKey) {
  return String(recipientKey ?? "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hydrateDraft(value) {
  if (!isRecord(value)) return emptyDraft();
  const draft = emptyDraft();
  for (const field of DRAFT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) draft[field] = value[field];
  }
  if (typeof draft.msgBody !== "string") draft.msgBody = "";
  if (!Array.isArray(draft.attachments)) draft.attachments = [];
  if (!isRecord(draft.insertedCustomerLinks)) draft.insertedCustomerLinks = {};
  if (typeof draft.sendTiming !== "string") draft.sendTiming = "now";
  if (typeof draft.sendCustomAt !== "string") draft.sendCustomAt = "";
  if (typeof draft.fromNumber !== "string") draft.fromNumber = "";
  return draft;
}

function persistedDraft(draft) {
  return {
    ...draft,
    attachments: Array.isArray(draft.attachments)
      ? draft.attachments.map((attachment) => {
          if (!isRecord(attachment)) return attachment;
          const stored = { ...attachment };
          if (stored.url) stored.previewUrl = stored.url;
          else delete stored.previewUrl;
          return stored;
        })
      : [],
  };
}

function readStorage() {
  const raw = sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY);
  let parsed;
  try {
    parsed = JSON.parse(raw || "null");
  } catch {
    return { owners: {} };
  }
  return isRecord(parsed) && isRecord(parsed.owners) ? parsed : { owners: {} };
}

function readPersistedDraft(ownerId, recipientKey, initialDraft) {
  try {
    const stored = readStorage();
    const accountDrafts = stored.owners[ownerId];
    const hasStoredDraft = isRecord(accountDrafts)
      && Object.prototype.hasOwnProperty.call(accountDrafts, recipientKey);
    return {
      draft: hydrateDraft(hasStoredDraft ? accountDrafts[recipientKey] : initialDraft),
      recoveryWarning: null,
      revision: 0,
    };
  } catch {
    return {
      draft: hydrateDraft(initialDraft),
      recoveryWarning: SMS_DRAFT_RECOVERY_WARNING,
      revision: 0,
    };
  }
}

function persist(ownerId, recipientKey, draft) {
  try {
    const stored = readStorage();
    const owners = { ...stored.owners };
    const accountDrafts = isRecord(owners[ownerId]) ? { ...owners[ownerId] } : {};
    if (draft) accountDrafts[recipientKey] = persistedDraft(draft);
    else delete accountDrafts[recipientKey];
    if (Object.keys(accountDrafts).length) owners[ownerId] = accountDrafts;
    else delete owners[ownerId];
    sessionStorage.setItem(SMS_DRAFT_STORAGE_KEY, JSON.stringify({ owners }));
    return null;
  } catch {
    return SMS_DRAFT_RECOVERY_WARNING;
  }
}

function storeFor(ownerId, instanceMemory) {
  if (ownerId === null) return instanceMemory;
  let store = ownerMemory.get(ownerId);
  if (!store) {
    store = createStore();
    ownerMemory.set(ownerId, store);
  }
  return store;
}

function entryFor(store, ownerId, recipientKey, initialDraft = null) {
  if (!store.entries.has(recipientKey)) {
    store.entries.set(
      recipientKey,
      ownerId === null
        ? { draft: hydrateDraft(initialDraft), recoveryWarning: null, revision: 0 }
        : readPersistedDraft(ownerId, recipientKey, initialDraft),
    );
  }
  return store.entries.get(recipientKey);
}

function publish(store, recipientKey, entry) {
  store.entries.set(recipientKey, entry);
  for (const listener of store.listeners.get(recipientKey) || []) listener();
}

function subscribe(store, recipientKey, listener) {
  let listeners = store.listeners.get(recipientKey);
  if (!listeners) {
    listeners = new Set();
    store.listeners.set(recipientKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) store.listeners.delete(recipientKey);
  };
}

function mergeDraft(draft, patch) {
  if (!isRecord(patch)) return draft;
  const next = { ...draft };
  for (const field of DRAFT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) next[field] = patch[field];
  }
  return next;
}

function draftChanged(previous, next) {
  return DRAFT_FIELDS.some((field) => !Object.is(previous[field], next[field]));
}

function draftContentIsEmpty(draft) {
  return draft.msgBody === ""
    && Array.isArray(draft.attachments) && draft.attachments.length === 0
    && draft.insertedResched === null
    && draft.insertedReservice === null
    && isRecord(draft.insertedCustomerLinks) && Object.keys(draft.insertedCustomerLinks).length === 0
    && draft.loadedMessageDraft === null
    && draft.selectedAgentDraft === null
    && draft.replyContext === null
    && draft.sendTiming === "now"
    && draft.sendCustomAt === "";
}

export default function useSmsDraft({ ownerId, recipientKey, initialDraft = null } = {}) {
  const instanceMemory = useRef(null);
  if (!instanceMemory.current) instanceMemory.current = createStore();
  const owner = ownerKey(ownerId);
  const recipient = recipientKeyValue(recipientKey);
  const store = storeFor(owner, instanceMemory.current);
  const getSnapshot = useCallback(
    () => entryFor(store, owner, recipient, initialDraft),
    [store, owner, recipient, initialDraft],
  );
  const subscribeToRecipient = useCallback(
    (listener) => subscribe(store, recipient, listener),
    [store, recipient],
  );
  const entry = useSyncExternalStore(subscribeToRecipient, getSnapshot, getSnapshot);

  const api = useMemo(() => {
    const updateRecipient = (targetRecipient, update) => {
      const current = entryFor(store, owner, targetRecipient);
      const nextDraft = update(current.draft);
      if (!draftChanged(current.draft, nextDraft)) return current.draft;
      const recoveryWarning = owner === null
        ? null
        : persist(owner, targetRecipient, nextDraft);
      publish(store, targetRecipient, {
        draft: nextDraft,
        recoveryWarning,
        revision: current.revision + 1,
      });
      return nextDraft;
    };

    const setField = (field) => (value) => updateRecipient(recipient, (draft) => ({
      ...draft,
      [field]: typeof value === "function" ? value(draft[field]) : value,
    }));

    return {
      setMsgBody: setField("msgBody"),
      setAttachments: setField("attachments"),
      setInsertedResched: setField("insertedResched"),
      setInsertedReservice: setField("insertedReservice"),
      setInsertedCustomerLinks: setField("insertedCustomerLinks"),
      setLoadedMessageDraft: setField("loadedMessageDraft"),
      setSelectedAgentDraft: setField("selectedAgentDraft"),
      setReplyContext: setField("replyContext"),
      setSendTiming: setField("sendTiming"),
      setSendCustomAt: setField("sendCustomAt"),
      setFromNumber: setField("fromNumber"),
      setSelectedCustomerId: setField("selectedCustomerId"),
      setThreadLock: setField("threadLock"),
      setDraftForRecipient(targetKey, patch) {
        const targetRecipient = recipientKeyValue(targetKey);
        return updateRecipient(targetRecipient, (draft) => {
          const resolvedPatch = typeof patch === "function" ? patch(draft) : patch;
          return mergeDraft(draft, resolvedPatch);
        });
      },
      clearDraft(expectedRevision = entry.revision) {
        const current = entryFor(store, owner, recipient);
        if (current.revision !== expectedRevision) return { cleared: false, persisted: current.recoveryWarning === null };
        const recoveryWarning = owner === null ? null : persist(owner, recipient, null);
        if (draftContentIsEmpty(current.draft)) {
          if (current.recoveryWarning !== recoveryWarning) {
            publish(store, recipient, { ...current, recoveryWarning });
          }
          return { cleared: true, persisted: recoveryWarning === null };
        }
        publish(store, recipient, {
          draft: {
            ...emptyDraft(),
            fromNumber: current.draft.fromNumber,
            selectedCustomerId: current.draft.selectedCustomerId,
            threadLock: current.draft.threadLock,
          },
          recoveryWarning,
          revision: current.revision + 1,
        });
        return { cleared: true, persisted: recoveryWarning === null };
      },
    };
  }, [owner, recipient, store, entry.revision]);

  return {
    ...entry.draft,
    ...api,
    draftRevision: entry.revision,
    recoveryWarning: entry.recoveryWarning,
  };
}
