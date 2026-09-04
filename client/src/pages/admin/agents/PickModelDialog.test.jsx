// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG } from "./modelDraft.fixture";

vi.mock("../../../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));

import { adminFetch } from "../../../utils/admin-fetch";
import PickModelDialog from "./PickModelDialog";

const target = { accepts: { providers: ["anthropic"], cap: "text", deep: false }, current: "m1", title: "SMS intent", subtitle: "Works out what a text asks for" };

afterEach(cleanup);
beforeEach(() => {
  adminFetch.mockReset();
});

describe("PickModelDialog", () => {
  it("lists what the lane can run today and refuses a pick the provider does not know", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.startsWith("/admin/agents/models/search")) return { newest: [{ provider: "anthropic", items: [{ id: "m9", label: "Claude Next", provider: "anthropic" }] }], unavailable: [] };
      if (path === "/admin/agents/models/probe") return { ok: false, reason: "not_found" };
      throw new Error(path);
    });
    const onPick = vi.fn();
    render(<PickModelDialog target={target} catalog={CATALOG} onClose={() => {}} onPick={onPick} />);
    // Same-provider catalog models minus the current one; GPT models are not offered.
    expect(screen.getByText("Claude Opus 5")).toBeInTheDocument();
    expect(screen.queryByText("GPT-5.6 Terra")).toBeNull();
    expect(await screen.findByText("Claude Next")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Use" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("the provider does not know this id");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("drafts a pick flagged unverified when the provider check cannot run here", async () => {
    adminFetch.mockImplementation(async (path) => {
      if (path.startsWith("/admin/agents/models/search")) return { newest: [], unavailable: [{ provider: "anthropic", reason: "no_key" }] };
      if (path === "/admin/agents/models/probe") return { ok: false, reason: "no_key" };
      throw new Error(path);
    });
    const onPick = vi.fn();
    render(<PickModelDialog target={target} catalog={CATALOG} onClose={() => {}} onPick={onPick} />);
    expect(await screen.findByText(/Not searched live: Anthropic \(no API key on this server\)/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Use" })[0]);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "m2", unverified: true })));
  });
});
