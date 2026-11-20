// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import useOfferFlow from "./useOfferFlow";
import { fetchOffer } from "./offerApi";

vi.mock("./offerApi", () => ({ fetchOffer: vi.fn() }));

const panel = (draftHash) => ({ enabled: true, viewer: { ownerActions: true }, draft: null, current: { id: "offer-1", status: "draft", draftHash } });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  fetchOffer.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useOfferFlow", () => {
  // A form's own action can finish after the owner opened another form. Its close names its own form, so it never
  // closes the newer one or drops that form's edits.
  it("closes a form only by its own key", async () => {
    fetchOffer.mockResolvedValue(panel("hash-1"));
    const { result } = renderHook(() => useOfferFlow("app-1", "offer"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => result.current.openForm());
    const first = result.current.form.key;
    act(() => result.current.closeForm(first));
    expect(result.current.form).toBeNull();
    act(() => result.current.openForm());
    const second = result.current.form.key;
    expect(second).not.toBe(first);
    act(() => result.current.closeForm(first));
    expect(result.current.form).toMatchObject({ key: second });
    act(() => result.current.closeForm(second));
    expect(result.current.form).toBeNull();
  });

  // Two reads can overlap (a stage change re-reads while a form's own read is out). The page shows only the newer
  // one, so the older read must not hand its caller data the page dropped: a form would act on it as current.
  it("answers null to a read that a newer read replaced, even when the newer read fails", async () => {
    fetchOffer.mockResolvedValueOnce(panel("hash-1"));
    const { result } = renderHook(() => useOfferFlow("app-1", "offer"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    const older = deferred();
    fetchOffer.mockImplementationOnce(() => older.promise);
    fetchOffer.mockRejectedValueOnce(Object.assign(new Error("Network down"), { status: 0 }));
    let olderRead;
    let newerRead;
    act(() => {
      olderRead = result.current.reload();
      newerRead = result.current.reload();
    });
    await expect(newerRead).resolves.toBeNull();
    await act(async () => older.resolve(panel("hash-2")));
    await expect(olderRead).resolves.toBeNull();
    expect(result.current.data.current.draftHash).toBe("hash-1");
    expect(result.current.refreshError).toBeTruthy();
  });
});
