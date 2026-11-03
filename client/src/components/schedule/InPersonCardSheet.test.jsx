// @vitest-environment jsdom
// Booked sheet for "Book at the Table" (GATE_IN_PERSON_CARD, owner 2026-11-02).
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") },
}));
import QRCode from "qrcode";
import InPersonCardSheet, { POLL_INTERVAL_MS } from "./InPersonCardSheet";
import { CAPABILITIES_TIMEOUT_MS } from "../../lib/wavesAdminHandoff";

const SECURE = "https://portal.example.test/secure/tok123";
const BASE = {
  visitId: "visit-1",
  date: "2026-11-03",
  time: "9:00 AM",
  serviceName: "Quarterly Pest Control Service",
  estimateAccepted: true,
  estimateRef: "EST-2026-0001",
  confirmationText: true,
  firstName: "Pat",
};

function makeFetch({ inPerson, card = { request: { status: "pending" }, autopayActive: false }, text } = {}) {
  return vi.fn(async (path, options = {}) => {
    if (path.endsWith("/card-request/in-person")) return inPerson;
    if (path.endsWith("/card-request") && options.method === "POST") return text || { requested: true, action: "sent", reason: "sent" };
    if (path.endsWith("/card-request")) return typeof card === "function" ? card() : card;
    throw new Error(`unexpected ${path}`);
  });
}

const LINK = { requested: true, action: "link_created", reason: "created", secureUrl: SECURE };

function renderSheet(props = {}, fetcher = makeFetch({ inPerson: LINK })) {
  const onClose = vi.fn();
  const view = render(<InPersonCardSheet {...BASE} adminFetch={fetcher} onClose={onClose} {...props} />);
  return { fetcher, onClose, ...view };
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); delete window.webkit; });

// The Waves Admin app's side of the bridge: answers capabilities, records every
// message, and lets a test answer the hand-off itself.
function installAdminApp({ capabilities = ["handoffOpen"] } = {}) {
  const messages = [];
  window.webkit = {
    messageHandlers: {
      wavesAdmin: {
        postMessage: vi.fn((message) => {
          messages.push(message);
          if (message.type === "capabilities" && capabilities) {
            queueMicrotask(() => window.dispatchEvent(new CustomEvent("wavesadmin:capabilities", { detail: { requestId: message.requestId, capabilities } })));
          }
        }),
      },
    },
  };
  const answer = (status, extra = {}) => {
    const open = messages.find((m) => m.type === "handoffOpen");
    window.dispatchEvent(new CustomEvent("wavesadmin:handoff", { detail: { requestId: open.requestId, status, ...extra } }));
  };
  return { messages, answer };
}

describe("InPersonCardSheet", () => {
  it("shows the booking rows exactly, then the card section and its actions", async () => {
    const { fetcher } = renderSheet();
    expect(screen.getByRole("heading", { name: "Booked" })).toBeInTheDocument();
    expect(screen.getByText("Tue, Nov 3, 9:00 AM")).toBeInTheDocument();
    expect(screen.getByText("Quarterly Pest Control Service")).toBeInTheDocument();
    expect(screen.getByText("Estimate EST-2026-0001 marked accepted")).toBeInTheDocument();
    expect(screen.getByText("Confirmation text going out")).toBeInTheDocument();
    expect(await screen.findByText("Card for Auto Pay")).toBeInTheDocument();
    expect(screen.getByText("Pat can save a card now on their own phone: show the QR code, or text the link. Nothing is charged today. Auto Pay charges after each completed service.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Hand the phone/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Show a QR code" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Text the link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/admin/schedule/visit-1/card-request/in-person", { method: "POST" });
  });

  it("omits the estimate and confirmation rows when they do not apply", async () => {
    renderSheet({ estimateAccepted: false, confirmationText: false });
    await screen.findByText("Card for Auto Pay");
    expect(screen.queryByText(/marked accepted/)).toBeNull();
    expect(screen.queryByText("Confirmation text going out")).toBeNull();
  });

  describe("Hand the phone (Waves Admin app)", () => {
    it("is hidden outside the app and when the app does not list handoffOpen", async () => {
      renderSheet();
      await screen.findByText("Card for Auto Pay");
      expect(screen.queryByRole("button", { name: "Hand the phone to Pat" })).toBeNull();
      cleanup();
      installAdminApp({ capabilities: ["saveCard"] });
      renderSheet();
      await screen.findByText("Card for Auto Pay");
      await act(async () => { await Promise.resolve(); });
      expect(screen.queryByRole("button", { name: "Hand the phone to Pat" })).toBeNull();
    });

    it("is hidden when an older app never answers the capabilities ask", async () => {
      vi.useFakeTimers();
      installAdminApp({ capabilities: null });
      renderSheet();
      await act(async () => { await vi.advanceTimersByTimeAsync(CAPABILITIES_TIMEOUT_MS + 50); });
      expect(screen.getByText("Card for Auto Pay")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Hand the phone to Pat" })).toBeNull();
    });

    it("asks the app to open the hand-off, never navigates, then reads the card state", async () => {
      const app = installAdminApp();
      const fetcher = makeFetch({ inPerson: LINK, card: { request: { status: "completed" }, autopayActive: false } });
      const before = window.location.href;
      renderSheet({}, fetcher);
      fireEvent.click(await screen.findByRole("button", { name: "Hand the phone to Pat" }));
      expect(app.messages.find((m) => m.type === "handoffOpen")).toMatchObject({
        url: "https://portal.example.test/secure/tok123?handoff=1",
        firstName: "Pat",
      });
      expect(screen.getByRole("button", { name: "With Pat…" })).toBeDisabled();
      await act(async () => { app.answer("ended"); });
      expect(await screen.findByText("Saved. Auto Pay is on.")).toBeInTheDocument();
      expect(fetcher).toHaveBeenCalledWith("/admin/schedule/visit-1/card-request");
      expect(window.location.href).toBe(before);
      expect(screen.getByRole("button", { name: "Hand the phone to Pat" })).toBeEnabled();
    });

    it("says plainly when the card was not saved, and when the hand-off failed", async () => {
      const app = installAdminApp();
      renderSheet();
      fireEvent.click(await screen.findByRole("button", { name: "Hand the phone to Pat" }));
      await act(async () => { app.answer("ended"); });
      expect(await screen.findByText(/Not saved yet/)).toBeInTheDocument();
      cleanup();
      const failing = installAdminApp();
      renderSheet();
      fireEvent.click(await screen.findByRole("button", { name: "Hand the phone to Pat" }));
      await act(async () => { failing.answer("failed", { message: "Face ID is not set up." }); });
      expect(await screen.findByText("Face ID is not set up.")).toBeInTheDocument();
    });
  });

  it("auto_secured: says Auto Pay is on and offers only Done", async () => {
    const { onClose } = renderSheet({}, makeFetch({ inPerson: { requested: false, action: "auto_secured", reason: "saved_method_satisfied" } }));
    expect(await screen.findByText("Auto Pay is already on for Pat.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show a QR code" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("skipped payer_billed: plain third-party payer line, only Done", async () => {
    renderSheet({}, makeFetch({ inPerson: { requested: false, action: "skipped", reason: "payer_billed" } }));
    expect(await screen.findByText("This visit bills a third-party payer, so no card is asked for.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show a QR code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("a failed call keeps the booking and offers Try again", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(LINK);
    renderSheet({}, fetcher);
    expect(await screen.findByText("The card page did not load. The booking is saved.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Show a QR code" })).toBeInTheDocument();
  });

  it("Text the link posts the existing card-request route and shows the result", async () => {
    const fetcher = makeFetch({ inPerson: LINK, text: { requested: true, action: "sent", reason: "sent" } });
    renderSheet({}, fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Text the link" }));
    expect(await screen.findByText("Secure card link texted")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/admin/schedule/visit-1/card-request", { method: "POST" });
  });

  it("Text the link on a customer with past visits explains why nothing was sent", async () => {
    renderSheet({}, makeFetch({ inPerson: LINK, text: { requested: false, action: "skipped", reason: "existing_customer" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Text the link" }));
    expect(await screen.findByText(/has past visits/)).toBeInTheDocument();
  });

  it("Not now closes", async () => {
    const { onClose } = renderSheet();
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalled();
  });

  describe("QR code", () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }); });

    async function openQr(fetcher) {
      renderSheet({}, fetcher);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole("button", { name: "Show a QR code" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    }
    const pollCalls = (fetcher) => fetcher.mock.calls.filter(([p, o]) => p.endsWith("/card-request") && !o);

    it("encodes the absolute secure URL, waits, and does not poll before it is shown", async () => {
      const fetcher = makeFetch({ inPerson: LINK });
      renderSheet({}, fetcher);
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3); });
      expect(pollCalls(fetcher)).toHaveLength(0);
      fireEvent.click(screen.getByRole("button", { name: "Show a QR code" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(QRCode.toDataURL).toHaveBeenCalledWith(SECURE, expect.any(Object));
      expect(screen.getByText("Waiting for Pat's phone…")).toBeInTheDocument();
      expect(screen.getByAltText("QR code for the card page")).toBeInTheDocument();
    });

    it("polls every 4 s while shown, stops when hidden", async () => {
      const fetcher = makeFetch({ inPerson: LINK });
      await openQr(fetcher);
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2); });
      expect(pollCalls(fetcher)).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Hide the QR code" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3); });
      expect(pollCalls(fetcher)).toHaveLength(2);
    });

    it("stops polling and shows Saved when the request completes", async () => {
      let state = { request: { status: "pending" }, autopayActive: false };
      const fetcher = makeFetch({ inPerson: LINK, card: () => state });
      await openQr(fetcher);
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
      expect(screen.getByText("Waiting for Pat's phone…")).toBeInTheDocument();
      state = { request: { status: "completed" }, autopayActive: false };
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
      expect(screen.getByText("Saved. Auto Pay is on.")).toBeInTheDocument();
      const count = pollCalls(fetcher).length;
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4); });
      expect(pollCalls(fetcher)).toHaveLength(count);
    });

    it("autopayActive alone also counts as saved", async () => {
      const fetcher = makeFetch({ inPerson: LINK, card: { request: { status: "pending" }, autopayActive: true } });
      await openQr(fetcher);
      await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });
      expect(screen.getByText("Saved. Auto Pay is on.")).toBeInTheDocument();
    });
  });
});
