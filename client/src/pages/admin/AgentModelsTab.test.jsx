// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeData } from "./agents/modelDraft.fixture";

vi.mock("../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));

import { adminFetch } from "../../utils/admin-fetch";
import AgentModelsTab from "./AgentModelsTab";

afterEach(cleanup);
beforeEach(() => {
  adminFetch.mockReset();
  adminFetch.mockImplementation(async (path, init) => {
    if (path === "/admin/agents/models") return makeData();
    if (path.startsWith("/admin/agents/models/search")) return { newest: [], results: [], unavailable: [] };
    if (path === "/admin/agents/models/probe") return { ok: true, provider: JSON.parse(init.body).provider, id: JSON.parse(init.body).id };
    throw new Error(`unexpected fetch ${path}`);
  });
});

function renderTab(entry = "/admin/agents?tab=models") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AgentModelsTab />
    </MemoryRouter>,
  );
}

describe("AgentModelsTab", () => {
  it("renders one card per lane grouped by area, with model names only", async () => {
    renderTab();
    expect(await screen.findByText("SMS intent")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "SMS & messaging" })).toBeInTheDocument();
    const card = screen.getByText("SMS intent").closest(".p-4");
    expect(within(card).getByText("Claude Opus 4.8")).toBeInTheDocument();
    expect(within(card).getByText("GPT-5.6 Luna")).toBeInTheDocument();
    // No env / file vocabulary on a card.
    expect(within(card).queryByText(/MODEL_FLAGSHIP|Model via|Where/)).toBeNull();
    const draftCard = screen.getByText("SMS draft").closest(".p-4");
    expect(within(draftCard).getByText("No backup")).toBeInTheDocument();
  });

  it("?area= narrows to that area and the No backup chip filters", async () => {
    renderTab("/admin/agents?tab=models&area=ib");
    expect(await screen.findByRole("heading", { name: "Intelligence Bar" })).toBeInTheDocument();
    expect(screen.getAllByText("Intelligence Bar")).toHaveLength(2); // area heading + the one lane
    expect(screen.queryByText("SMS intent")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "No backup" }));
    expect(screen.getByText("No lanes match this filter.")).toBeInTheDocument();
  });

  it("picking a model for a lane drafts the shared setting and the review dialog shows the env line", async () => {
    renderTab();
    const card = (await screen.findByText("SMS intent")).closest(".p-4");
    fireEvent.click(within(card).getByRole("button", { name: /Change/ }));
    // Dialog lists what the lane can run; Use probes then drafts.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Claude Opus 5")).toBeInTheDocument();
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Use" })[0]);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/agents/models/probe", expect.objectContaining({ method: "POST" })));
    // The selector moves every unpinned follower: SMS intent, SMS draft, Deep audit.
    expect(await screen.findByText(/lanes move after restart/)).toHaveTextContent(/^3 lanes move after restart$/);
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText("MODEL_FLAGSHIP=m2")).toBeInTheDocument();
    // Two of the moving lanes have nothing to degrade to — the dialog says so instead of promising a backup.
    expect(screen.getByText(/No backup for SMS draft, Deep audit/)).toBeInTheDocument();
    expect(screen.queryByText(/Every moving lane keeps its backup/)).toBeNull();
  });

  it("a lane on an overridden selector can delete the override, back to the registry default", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/agents/models") {
        const data = makeData();
        Object.assign(data.selectors[0], { overridden: true, overrideEnv: "MODEL_FLAGSHIP", codeDefault: "m2", unpinnedModel: "m2" });
        return data;
      }
      if (path.startsWith("/admin/agents/models/search")) return { newest: [], results: [], unavailable: [] };
      throw new Error(path);
    });
    renderTab();
    const card = (await screen.findByText("SMS intent")).closest(".p-4");
    fireEvent.click(within(card).getByRole("button", { name: /Change/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Remove the FLAGSHIP override · back to the registry default \(Claude Opus 5\)/ }));
    expect(await screen.findByText(/lanes move after restart/)).toHaveTextContent(/^3 lanes move after restart$/);
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText(/# delete MODEL_FLAGSHIP \(unpin → Claude Opus 5\)/)).toBeInTheDocument();
  });

  it("moving a lane's backup never promises that backup as coverage", async () => {
    renderTab();
    await screen.findByText("SMS intent");
    const card = screen.getAllByText("Intelligence Bar").map((e) => e.closest(".p-4")).find(Boolean); // the lane card, not the area heading
    fireEvent.click(within(card).getByRole("button", { name: "Show details for Intelligence Bar" }));
    const change = within(card).getAllByRole("button", { name: "Change" });
    fireEvent.click(change[change.length - 1]); // the backup leg (OPENAI_FAST)
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Use" })[0]);
    await waitFor(() => expect(adminFetch).toHaveBeenCalledWith("/admin/agents/models/probe", expect.objectContaining({ method: "POST" })));
    fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
    expect(await screen.findByText(/No backup for SMS intent, Intelligence Bar/)).toBeInTheDocument();
    expect(screen.queryByText(/Every moving lane keeps its backup/)).toBeNull();
  });

  it("an unverified draft keeps its warning until THAT draft is replaced or discarded", async () => {
    adminFetch.mockImplementation(async (path, init) => {
      if (path === "/admin/agents/models") return makeData();
      if (path.startsWith("/admin/agents/models/search")) return { newest: [], results: [], unavailable: [] };
      if (path === "/admin/agents/models/probe") {
        const body = JSON.parse(init.body);
        return body.id === "m2" ? { ok: false, reason: "no_key" } : { ok: true, provider: body.provider, id: body.id }; // only Opus 5 is unverifiable here
      }
      return {};
    });
    renderTab();
    const sms = (await screen.findByText("SMS intent")).closest(".p-4");
    fireEvent.click(within(sms).getByRole("button", { name: /Change/ }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Use" })[0]); // Claude Opus 5 (m2) → cannot be checked here → unverified
    expect(await screen.findByText(/Drafted UNVERIFIED/)).toHaveTextContent(/Claude Opus 5 \(MODEL_FLAGSHIP\)/);
    // A later VERIFIED pick on another env must not clear it.
    const ib = screen.getAllByText("Intelligence Bar").map((e) => e.closest(".p-4")).find(Boolean);
    fireEvent.click(within(ib).getByRole("button", { name: "Show details for Intelligence Bar" }));
    const change = within(ib).getAllByRole("button", { name: "Change" });
    fireEvent.click(change[change.length - 1]);
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Use" })[0]);
    await waitFor(() => expect(adminFetch.mock.calls.filter((c) => c[0] === "/admin/agents/models/probe")).toHaveLength(2));
    expect(screen.getByText(/Drafted UNVERIFIED/)).toHaveTextContent(/MODEL_FLAGSHIP/);
    // Discarding the unverified draft clears its warning.
    fireEvent.click(screen.getByRole("button", { name: "Discard change to SMS intent" }));
    await waitFor(() => expect(screen.queryByText(/Drafted UNVERIFIED/)).toBeNull());
  });

  it("discarding a selector draft also drops the hold it generated for a locked follower", async () => {
    adminFetch.mockImplementation(async (path, init) => {
      if (path === "/admin/agents/models") {
        const data = makeData();
        // A locked lane that follows FLAGSHIP through its own UNSET env: drafting FLAGSHIP holds it via PIN_PROBE.
        data.lanes.push({ id: "mentions_prober", name: "Mentions prober", describe: "Probes the answer engines", area: "sms", continuity: "verified", inbound: false, lock: { label: "Measurement probe", detail: "frozen" }, fanout: false, applies: "restart", primary: { model: "m1", selector: "FLAGSHIP", pinEnv: "PIN_PROBE", setEnv: null, pinned: false, unpinnedModel: "m1", accepts: { providers: ["anthropic"], cap: "text", deep: false }, live: false }, fallback: null, retry: null, also: [] });
        return data;
      }
      if (path.startsWith("/admin/agents/models/search")) return { newest: [], results: [], unavailable: [] };
      if (path === "/admin/agents/models/probe") return { ok: true, provider: JSON.parse(init.body).provider, id: JSON.parse(init.body).id };
      return {};
    });
    renderTab();
    const sms = (await screen.findByText("SMS intent")).closest(".p-4");
    fireEvent.click(within(sms).getByRole("button", { name: /Change/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Use" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
    const envBlock = () => Array.from(document.querySelectorAll("pre")).map((e) => e.textContent).join("\n");
    await waitFor(() => expect(envBlock()).toMatch(/MODEL_FLAGSHIP=m2/));
    expect(envBlock()).toMatch(/PIN_PROBE=m1/); // the hold
    fireEvent.click(screen.getByRole("button", { name: "Discard change to SMS intent" }));
    await waitFor(() => expect(envBlock()).not.toMatch(/MODEL_FLAGSHIP=m2/));
    expect(envBlock()).not.toMatch(/PIN_PROBE=m1/);
    expect(screen.queryByText(/lanes? moves? after restart/)).toBeNull();
  });

  it("a fan-out lane shows its second model as running alongside, not as a backup", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/agents/models") {
        const data = makeData();
        data.lanes[0].fanout = true;
        return data;
      }
      throw new Error(path);
    });
    renderTab();
    const card = (await screen.findByText("SMS intent")).closest(".p-4");
    expect(within(card).getByText(/Alongside/)).toBeInTheDocument();
    expect(within(card).queryByText(/Backup/)).toBeNull();
  });

  it("a failed load offers Retry, and a failed refresh keeps the lanes on screen", async () => {
    let fail = true;
    adminFetch.mockImplementation(async (path) => {
      if (path === "/admin/agents/models") {
        if (fail) throw new Error("upstream 502");
        return makeData();
      }
      throw new Error(path);
    });
    renderTab();
    expect(await screen.findByRole("alert")).toHaveTextContent("upstream 502");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("SMS intent")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Move a model… walks the migration set and drafts only the eligible env", async () => {
    renderTab();
    await screen.findByText("SMS intent");
    fireEvent.click(screen.getByRole("button", { name: /Move a model/ }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Move" })[0]); // Claude Opus 4.8, most used
    fireEvent.click(within(dialog).getByRole("button", { name: "Pick the target model" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Use" })[0]); // Claude Opus 5
    expect(await screen.findByText("Eligible")).toBeInTheDocument();
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Report copy")).toBeInTheDocument();
    expect(within(dialog).getByText(/carries customer content/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Draft eligible" }));
    const bar = await screen.findByText(/lane move after restart/);
    expect(bar).toHaveTextContent(/^1 lane move after restart$/);
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText("PIN_REPORT=m2")).toBeInTheDocument();
    expect(screen.queryByText("MODEL_FLAGSHIP=m2")).toBeNull();
  });

  it("Move a model… to a target found by live search still classifies the set (not 'unknown model')", async () => {
    adminFetch.mockImplementation(async (path, init) => {
      if (path === "/admin/agents/models") return makeData();
      if (path.startsWith("/admin/agents/models/search")) {
        return path.includes("q=next") ? { results: [{ id: "m9", label: "Claude Next", provider: "anthropic" }], unavailable: [] } : { newest: [], results: [], unavailable: [] };
      }
      if (path === "/admin/agents/models/probe") return { ok: true, provider: JSON.parse(init.body).provider, id: JSON.parse(init.body).id };
      throw new Error(path);
    });
    renderTab();
    await screen.findByText("SMS intent");
    fireEvent.click(screen.getByRole("button", { name: /Move a model/ }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Move" })[0]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Pick the target model" }));
    dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/fable 5.1/), { target: { value: "next" } });
    expect(await within(dialog).findByText("Claude Next")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Use" }));
    expect(await screen.findByText("Eligible")).toBeInTheDocument();
    dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/unknown model/)).toBeNull();
    expect(within(dialog).getByText("Report copy")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Draft eligible" })).toBeEnabled();
  });
});
