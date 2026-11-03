// @vitest-environment jsdom
/**
 * Book at the Table (GATE_IN_PERSON_CARD, owner 2026-11-02). The card choice in the
 * booking window: gate off keeps today's checkbox; gate on shows the "Card for Auto Pay"
 * radio group (default "No card ask"). "Text them the link" is today's sendCardOnFileLink;
 * "Customer saves it here, now" sends no link with the booking and, once it saves, shows the
 * Booked sheet instead of closing (callers close on a non-background report).
 */
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
vi.mock("../../hooks/useDiscountStacking", () => ({
  useDiscountStackingState: vi.fn(() => ({ enabled: false, known: true, retry: vi.fn() })),
  ensureStackingFresh: vi.fn(async () => ({ enabled: true, known: true })),
}));
vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn(async () => "data:image/png;base64,QR") } }));
import CreateAppointmentModal from "./CreateAppointmentModal.jsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: vi.fn(async () => body) });
const CUSTOMER = { id: "customer-a", firstName: "Pat", lastName: "Example" };

function futureDate(days = 30) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

function installFetch({ availability, inPersonResult }) {
  const fetcher = vi.fn((input, options = {}) => {
    const url = String(input);
    if (url.includes("/admin/triage?")) return Promise.resolve(json({ items: [] }));
    if (url.includes("/admin/services?")) {
      return Promise.resolve(json({ services: [{ id: "svc-1", service_key: "pest_control_quarterly", name: "Quarterly Pest Control Service", billing_type: "recurring", frequency: "quarterly", base_price: 100, default_duration_minutes: 30 }] }));
    }
    if (url.endsWith("/admin/schedule") && options.method === "POST") return Promise.resolve(json({ id: "appt-1" }));
    if (url.endsWith("/card-request/in-person")) return Promise.resolve(json(inPersonResult));
    if (url.includes("/properties?context=appointment_address")) return Promise.resolve(json({ properties: [], canChangeAppointmentAddress: false }));
    if (url.includes("/schedule-estimates")) return Promise.resolve(json({ estimates: [] }));
    if (url.endsWith("/admin/technicians")) return Promise.resolve(json({ technicians: [] }));
    if (url.endsWith("/admin/discounts")) return Promise.resolve(json([]));
    if (url.endsWith("/annual-prepay-availability")) return Promise.resolve(json({ enabled: false }));
    if (url.endsWith("/card-request-availability")) return Promise.resolve(json(availability));
    if (url.endsWith("/admin/dispatch/slot-check")) return Promise.resolve(json({ ok: true, results: [{ conflicts: [] }] }));
    if (url.includes("/admin/schedule/find-time")) return Promise.resolve(json({ gated: true }));
    if (url.endsWith("/admin/schedule/preview") && options.method === "POST") {
      const groups = JSON.parse(options.body || "{}").groups || [];
      return Promise.resolve(json({ regime: true, results: groups.map((g) => ({ key: g.key })) }));
    }
    throw new Error(`Unhandled fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const handlers = () => ({ onClose: vi.fn(), onCreated: vi.fn(), onChange: vi.fn() });

async function mountWithService(h) {
  render(
    <MemoryRouter>
      <CreateAppointmentModal
        defaultCustomer={CUSTOMER}
        defaultDate={futureDate()}
        defaultWindowStart="09:00"
        {...h}
      />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText("Search services"), { target: { value: "Quarterly" } });
  fireEvent.click(await screen.findByRole("button", { name: /Quarterly Pest Control Service/ }));
}

const schedulePosts = (fetcher) => fetcher.mock.calls.filter(([u, o]) => String(u).endsWith("/admin/schedule") && o?.method === "POST");

async function submit() {
  const button = screen.getByRole("button", { name: "Schedule appointment" });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

describe("card choice in the booking window", () => {
  it("inPerson absent: today's checkbox and its copy, no radio group", async () => {
    installFetch({ availability: { enabled: true } });
    await mountWithService(handlers());
    expect(await screen.findByLabelText("Text card-on-file link (Auto Pay setup)")).toBeInTheDocument();
    expect(screen.queryByText("Card for Auto Pay")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("lane dark: no card control at all", async () => {
    const fetcher = installFetch({ availability: { enabled: false } });
    await mountWithService(handlers());
    await waitFor(() => expect(fetcher.mock.calls.some(([u]) => String(u).endsWith("/card-request-availability"))).toBe(true));
    expect(screen.queryByText("Text card-on-file link (Auto Pay setup)")).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("inPerson true: radio group, default No card ask, three labelled choices", async () => {
    installFetch({ availability: { enabled: true, inPerson: true } });
    await mountWithService(handlers());
    expect(await screen.findByText("Card for Auto Pay")).toBeInTheDocument();
    const radios = screen.getAllByRole("radio", { name: /Customer saves it here, now|Text them the link|No card ask/ });
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /No card ask/ })).toBeChecked();
    expect(screen.getByText("On this phone. Nothing charged today.")).toBeInTheDocument();
    expect(screen.getByText("Texts a secure link to save a card.")).toBeInTheDocument();
    expect(screen.queryByText("Text card-on-file link (Auto Pay setup)")).toBeNull();
  });

  it("Text them the link rides sendCardOnFileLink; No card ask does not", async () => {
    const fetcher = installFetch({ availability: { enabled: true, inPerson: true } });
    const h = handlers();
    await mountWithService(h);
    fireEvent.click(await screen.findByRole("radio", { name: /Text them the link/ }));
    expect(screen.getByRole("radio", { name: /Text them the link/ })).toBeChecked();
    await submit();
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body).sendCardOnFileLink).toBe(true);
    expect(fetcher.mock.calls.some(([u]) => String(u).endsWith("/card-request/in-person"))).toBe(false);
  });

  it("default (No card ask) sends no card link and shows no sheet", async () => {
    const fetcher = installFetch({ availability: { enabled: true, inPerson: true } });
    const h = handlers();
    await mountWithService(h);
    await screen.findByText("Card for Auto Pay");
    await submit();
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body)).not.toHaveProperty("sendCardOnFileLink");
    expect(fetcher.mock.calls.some(([u]) => String(u).endsWith("/card-request/in-person"))).toBe(false);
    expect(screen.queryByRole("heading", { name: "Booked" })).toBeNull();
  });

  it("Customer saves it here, now: no link in the booking, then the Booked sheet stays open and the callers hear a background save", async () => {
    const fetcher = installFetch({
      availability: { enabled: true, inPerson: true },
      inPersonResult: { requested: true, action: "link_created", reason: "created", secureUrl: "https://portal.example.test/secure/tok123" },
    });
    const h = handlers();
    await mountWithService(h);
    fireEvent.click(await screen.findByRole("radio", { name: /Customer saves it here, now/ }));
    await submit();
    await waitFor(() => expect(schedulePosts(fetcher)).toHaveLength(1));
    expect(JSON.parse(schedulePosts(fetcher)[0][1].body)).not.toHaveProperty("sendCardOnFileLink");

    expect(await screen.findByRole("heading", { name: "Booked" })).toBeInTheDocument();
    expect(screen.getByText("Quarterly Pest Control Service")).toBeInTheDocument();
    expect(screen.getByText("Confirmation text going out")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Hand the phone to Pat" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/admin/schedule/appt-1/card-request/in-person"), expect.objectContaining({ method: "POST" }));

    // Callers close on a non-background report: both reports say background, so they stay mounted.
    expect(h.onCreated).toHaveBeenCalledWith({ id: "appt-1", scheduledDate: expect.any(String) }, { background: true });
    expect(h.onChange).toHaveBeenCalledWith({ id: "appt-1", scheduledDate: expect.any(String) }, { background: true });
    for (const [, outcome] of [...h.onCreated.mock.calls, ...h.onChange.mock.calls]) expect(outcome?.background).toBe(true);
    expect(h.onClose).not.toHaveBeenCalled();

    // Not now closes through the caller's own onClose.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});
