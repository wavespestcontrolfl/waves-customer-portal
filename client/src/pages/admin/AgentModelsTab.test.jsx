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
});
