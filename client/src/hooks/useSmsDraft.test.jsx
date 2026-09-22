// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useSmsDraft, {
  SMS_DRAFT_RECOVERY_WARNING,
  SMS_DRAFT_STORAGE_KEY,
} from "./useSmsDraft";

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSmsDraft", () => {
  it("switches recipients atomically and restores each recipient's live text and attachments", () => {
    const attachmentA = {
      url: "https://media.example/a.jpg",
      key: "a",
      fileName: "a.jpg",
      previewUrl: "blob:preview-a",
    };
    const { result, rerender } = renderHook(
      ({ recipientKey }) => useSmsDraft({ ownerId: "owner-a", recipientKey }),
      { initialProps: { recipientKey: "recipient-a" } },
    );

    act(() => {
      result.current.setMsgBody("Draft A");
      result.current.setAttachments([attachmentA]);
      result.current.setInsertedCustomerLinks({
        contract: {
          url: "https://portal.example/contract/a",
          recipientKey: "recipient-a",
          customerId: "customer-a",
          contractId: "contract-a",
          expiresAt: "2026-09-22T12:00:00.000Z",
          immediateOnly: true,
        },
      });
    });

    rerender({ recipientKey: "recipient-b" });
    expect(result.current.msgBody).toBe("");
    expect(result.current.attachments).toEqual([]);
    expect(result.current.insertedCustomerLinks).toEqual({});

    act(() => {
      result.current.setMsgBody("Draft B");
      result.current.setAttachments([{ url: "https://media.example/b.jpg", previewUrl: "blob:preview-b" }]);
    });
    rerender({ recipientKey: "recipient-a" });

    expect(result.current.msgBody).toBe("Draft A");
    expect(result.current.attachments).toEqual([attachmentA]);
    expect(result.current.insertedCustomerLinks.contract).toMatchObject({
      contractId: "contract-a",
      expiresAt: "2026-09-22T12:00:00.000Z",
      immediateOnly: true,
    });

    const stored = JSON.parse(sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY));
    expect(stored.owners["owner-a"]["recipient-a"].attachments[0].previewUrl)
      .toBe("https://media.example/a.jpg");
    expect(JSON.stringify(stored)).not.toContain("blob:preview");
    expect(stored.owners["owner-a"]["recipient-a"].insertedCustomerLinks.contract)
      .toMatchObject({ contractId: "contract-a", immediateOnly: true });
  });

  it("recovers the full persisted draft on a later mount", () => {
    sessionStorage.setItem(SMS_DRAFT_STORAGE_KEY, JSON.stringify({
      owners: {
        "owner-recovery": {
          "recipient-a": {
            msgBody: "Recovered body",
            attachments: [{ url: "https://media.example/recovered.jpg", previewUrl: "https://media.example/recovered.jpg" }],
            insertedResched: { url: "https://portal.example/reschedule", recipientKey: "recipient-a", customerId: "customer-a" },
            insertedReservice: { url: "https://portal.example/reservice", recipientKey: "recipient-a", customerId: "customer-a" },
            insertedCustomerLinks: {
              review_request: { url: "https://portal.example/review", requestId: "request-a", emailToo: true },
            },
            loadedMessageDraft: { id: "approval-a", recipientPhone: "+19415550100" },
            selectedAgentDraft: { decisionId: "decision-a", suggestedMessage: "Suggestion" },
            replyContext: { messageId: "message-a", phone: "9415550100", customerId: "customer-a" },
            sendTiming: "custom",
            sendCustomAt: "2026-09-23T08:30",
            fromNumber: "+19415550200",
            selectedCustomerId: "customer-a",
            threadLock: { contactPhone: "+19415550100", ourNumber: "+19415550200", label: "Waves line" },
          },
        },
      },
    }));

    const { result } = renderHook(() => useSmsDraft({
      ownerId: "owner-recovery",
      recipientKey: "recipient-a",
    }));

    expect(result.current).toMatchObject({
      msgBody: "Recovered body",
      insertedResched: { customerId: "customer-a" },
      insertedReservice: { customerId: "customer-a" },
      insertedCustomerLinks: { review_request: { requestId: "request-a", emailToo: true } },
      loadedMessageDraft: { id: "approval-a" },
      selectedAgentDraft: { decisionId: "decision-a" },
      replyContext: { messageId: "message-a" },
      sendTiming: "custom",
      sendCustomAt: "2026-09-23T08:30",
      fromNumber: "+19415550200",
      selectedCustomerId: "customer-a",
      threadLock: { ourNumber: "+19415550200", label: "Waves line" },
    });
    expect(result.current.attachments[0].previewUrl).toBe("https://media.example/recovered.jpg");
  });

  it("keeps the same recipient separate across verified accounts", () => {
    const { result, rerender } = renderHook(
      ({ ownerId }) => useSmsDraft({ ownerId, recipientKey: "same-recipient" }),
      { initialProps: { ownerId: "owner-a" } },
    );

    act(() => result.current.setMsgBody("Owner A"));
    rerender({ ownerId: "owner-b" });
    expect(result.current.msgBody).toBe("");
    act(() => result.current.setMsgBody("Owner B"));
    rerender({ ownerId: "owner-a" });
    expect(result.current.msgBody).toBe("Owner A");
  });

  it("uses initialDraft only when a recipient has no stored or in-memory draft", () => {
    const initialDraft = {
      selectedCustomerId: "customer-a",
      fromNumber: "+19415550200",
      threadLock: { contactPhone: "+19415550100", ourNumber: "+19415550200", label: "Latest line" },
    };
    const { result, rerender } = renderHook(
      ({ seed }) => useSmsDraft({
        ownerId: "owner-seed",
        recipientKey: "recipient-seed",
        initialDraft: seed,
      }),
      { initialProps: { seed: initialDraft } },
    );

    expect(result.current).toMatchObject(initialDraft);
    act(() => result.current.setLoadedMessageDraft({ id: "approval-seed" }));
    rerender({
      seed: {
        selectedCustomerId: "customer-replacement",
        fromNumber: "+19415550300",
        threadLock: null,
      },
    });
    expect(result.current).toMatchObject({
      ...initialDraft,
      loadedMessageDraft: { id: "approval-seed" },
    });
  });

  it("keeps ownerless drafts private to each hook instance", () => {
    const first = renderHook(() => useSmsDraft({ recipientKey: "same-recipient" }));
    const second = renderHook(() => useSmsDraft({ recipientKey: "same-recipient" }));
    act(() => first.result.current.setMsgBody("Private draft"));
    expect(first.result.current.msgBody).toBe("Private draft");
    expect(second.result.current.msgBody).toBe("");
    expect(sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("never lets a setter captured for one recipient update the current recipient", () => {
    const { result, rerender } = renderHook(
      ({ recipientKey }) => useSmsDraft({ ownerId: "owner-stale", recipientKey }),
      { initialProps: { recipientKey: "recipient-a" } },
    );
    const staleSetBody = result.current.setMsgBody;
    rerender({ recipientKey: "recipient-b" });

    act(() => staleSetBody((body) => `${body}late response`));
    expect(result.current.msgBody).toBe("");
    rerender({ recipientKey: "recipient-a" });
    expect(result.current.msgBody).toBe("late response");
  });

  it("keeps simultaneous consumers of the same owned draft in sync", () => {
    const first = renderHook(() => useSmsDraft({
      ownerId: "owner-shared",
      recipientKey: "recipient-shared",
    }));
    const second = renderHook(() => useSmsDraft({
      ownerId: "owner-shared",
      recipientKey: "recipient-shared",
    }));

    act(() => first.result.current.setMsgBody("Written in the inbox"));
    expect(first.result.current.msgBody).toBe("Written in the inbox");
    expect(second.result.current.msgBody).toBe("Written in the inbox");
    expect(first.result.current.draftRevision).toBe(1);
    expect(second.result.current.draftRevision).toBe(1);

    act(() => second.result.current.setAttachments((attachments) => [
      ...attachments,
      { url: "https://media.example/shared.jpg" },
    ]));
    expect(first.result.current.attachments).toEqual([{ url: "https://media.example/shared.jpg" }]);
    expect(first.result.current.draftRevision).toBe(2);
    expect(second.result.current.draftRevision).toBe(2);
  });

  it("does not publish or revise identity-preserving setter updates", () => {
    const first = renderHook(() => useSmsDraft({
      ownerId: "owner-noop",
      recipientKey: "recipient-noop",
    }));
    const second = renderHook(() => useSmsDraft({
      ownerId: "owner-noop",
      recipientKey: "recipient-noop",
    }));
    const secondSnapshot = second.result.current;

    act(() => first.result.current.setMsgBody((body) => body));
    expect(first.result.current.draftRevision).toBe(0);
    expect(second.result.current).toBe(secondSnapshot);
    expect(sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("patches an explicit recipient atomically before the caller switches to it", () => {
    const { result, rerender } = renderHook(
      ({ recipientKey }) => useSmsDraft({ ownerId: "owner-target", recipientKey }),
      { initialProps: { recipientKey: "" } },
    );

    act(() => result.current.setDraftForRecipient("resolved-phone", {
      msgBody: "Approval draft",
      loadedMessageDraft: { id: "approval-a", recipientPhone: "+19415550100" },
      replyContext: { messageId: "message-a", phone: "9415550100" },
      fromNumber: "+19415550200",
      selectedCustomerId: "customer-a",
      threadLock: { contactPhone: "+19415550100", ourNumber: "+19415550200", label: "Approval line" },
    }));
    expect(result.current.msgBody).toBe("");

    rerender({ recipientKey: "resolved-phone" });
    expect(result.current).toMatchObject({
      msgBody: "Approval draft",
      loadedMessageDraft: { id: "approval-a" },
      replyContext: { messageId: "message-a" },
      fromNumber: "+19415550200",
      selectedCustomerId: "customer-a",
      threadLock: { ourNumber: "+19415550200", label: "Approval line" },
    });
  });

  it("clears only the recipient captured by clearDraft", () => {
    const { result, rerender } = renderHook(
      ({ recipientKey }) => useSmsDraft({ ownerId: "owner-clear", recipientKey }),
      { initialProps: { recipientKey: "recipient-a" } },
    );
    act(() => result.current.setMsgBody("Draft A"));
    const clearA = result.current.clearDraft;
    rerender({ recipientKey: "recipient-b" });
    act(() => result.current.setMsgBody("Draft B"));

    let clearResult;
    act(() => { clearResult = clearA(); });
    expect(clearResult).toEqual({ cleared: true, persisted: true });
    expect(result.current.msgBody).toBe("Draft B");
    rerender({ recipientKey: "recipient-a" });
    expect(result.current.msgBody).toBe("");
  });

  it("retains a newer shared edit when clearDraft receives a stale revision", () => {
    const first = renderHook(() => useSmsDraft({
      ownerId: "owner-revision",
      recipientKey: "recipient-revision",
    }));
    const second = renderHook(() => useSmsDraft({
      ownerId: "owner-revision",
      recipientKey: "recipient-revision",
    }));

    act(() => first.result.current.setMsgBody("Body being sent"));
    const sendRevision = first.result.current.draftRevision;
    act(() => second.result.current.setMsgBody("New edit during send"));

    let cleared;
    act(() => { cleared = first.result.current.clearDraft(sendRevision); });
    expect(cleared).toEqual({ cleared: false, persisted: true });
    expect(first.result.current.msgBody).toBe("New edit during send");
    expect(second.result.current.msgBody).toBe("New edit during send");
    expect(first.result.current.draftRevision).toBe(sendRevision + 1);

    act(() => { cleared = first.result.current.clearDraft(first.result.current.draftRevision); });
    expect(cleared).toEqual({ cleared: true, persisted: true });
    expect(first.result.current.msgBody).toBe("");
    expect(second.result.current.msgBody).toBe("");
  });

  it("preserves recipient identity in memory while removing the durable draft on clear", () => {
    const { result } = renderHook(() => useSmsDraft({
      ownerId: "owner-identity-clear",
      recipientKey: "recipient-identity-clear",
      initialDraft: {
        fromNumber: "+19415550200",
        selectedCustomerId: "customer-a",
        threadLock: { contactPhone: "+19415550100", ourNumber: "+19415550200" },
      },
    }));
    act(() => {
      result.current.setMsgBody("Sent body");
      result.current.setLoadedMessageDraft({ id: "approval-a" });
      result.current.setSendTiming("custom");
      result.current.setSendCustomAt("2026-09-23T08:30");
    });

    let cleared;
    act(() => { cleared = result.current.clearDraft(result.current.draftRevision); });
    expect(cleared).toEqual({ cleared: true, persisted: true });
    expect(result.current).toMatchObject({
      msgBody: "",
      loadedMessageDraft: null,
      sendTiming: "now",
      sendCustomAt: "",
      fromNumber: "+19415550200",
      selectedCustomerId: "customer-a",
      threadLock: { ourNumber: "+19415550200" },
    });
    const stored = JSON.parse(sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY));
    expect(stored?.owners?.["owner-identity-clear"]?.["recipient-identity-clear"])
      .toBeUndefined();
  });

  it("reports a durable cleanup failure while keeping the sent draft cleared in memory", () => {
    const { result } = renderHook(() => useSmsDraft({
      ownerId: "owner-clear-failure",
      recipientKey: "recipient-clear-failure",
    }));
    act(() => result.current.setMsgBody("Already handed to the provider"));
    const persistedBeforeClear = sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Synthetic cleanup failure");
    });

    let cleared;
    act(() => { cleared = result.current.clearDraft(result.current.draftRevision); });
    expect(cleared).toEqual({ cleared: true, persisted: false });
    expect(result.current.msgBody).toBe("");
    expect(result.current.recoveryWarning).toBe(SMS_DRAFT_RECOVERY_WARNING);
    expect(sessionStorage.getItem(SMS_DRAFT_STORAGE_KEY)).toBe(persistedBeforeClear);
  });

  it("retains in-memory edits and exposes a recovery warning when storage fails", () => {
    const { result, rerender } = renderHook(
      ({ recipientKey }) => useSmsDraft({ ownerId: "owner-quota", recipientKey }),
      { initialProps: { recipientKey: "recipient-a" } },
    );
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Synthetic quota failure");
    });

    act(() => {
      result.current.setMsgBody("Keep this edit");
      result.current.setAttachments([{ url: "https://media.example/keep.jpg", previewUrl: "blob:keep" }]);
    });
    expect(result.current.msgBody).toBe("Keep this edit");
    expect(result.current.attachments[0].previewUrl).toBe("blob:keep");
    expect(result.current.recoveryWarning).toBe(SMS_DRAFT_RECOVERY_WARNING);

    rerender({ recipientKey: "recipient-b" });
    rerender({ recipientKey: "recipient-a" });
    expect(result.current.msgBody).toBe("Keep this edit");
    expect(result.current.recoveryWarning).toBe(SMS_DRAFT_RECOVERY_WARNING);
  });
});
