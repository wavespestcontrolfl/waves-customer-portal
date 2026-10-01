// @vitest-environment jsdom
import React, { useEffect, useState } from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import KnowledgeGapPrompt, { useKnowledgeGaps } from "./KnowledgeGapPrompt";

afterEach(cleanup);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Mirrors the palette: the gap state lives in the parent, and the prompt
// unmounts while the palette is closed.
function Harness({ misses, save, variant, scope = null }) {
  const gaps = useKnowledgeGaps();
  const [open, setOpen] = useState(true);
  useEffect(() => { gaps.load(misses, scope); }, [misses]);
  return (
    <>
      <button type="button" onClick={() => setOpen((o) => !o)}>toggle palette</button>
      {/* A task status refresh re-delivers the same payload. */}
      <button type="button" onClick={() => gaps.load([...misses], scope)}>refresh task</button>
      <button type="button" onClick={() => gaps.load([...misses], "other-task")}>open other task</button>
      {open && <KnowledgeGapPrompt gaps={gaps.gaps} update={gaps.update} save={save} variant={variant} />}
    </>
  );
}

const box = () => screen.getByRole("textbox", { name: "Knowledge gap" });
const togglePalette = () => fireEvent.click(screen.getByRole("button", { name: "toggle palette" }));

describe("KnowledgeGapPrompt", () => {
  it("renders nothing without misses (the payload omits knowledgeMisses)", () => {
    render(<Harness misses={undefined} save={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Knowledge gaps" })).toBeNull();
    cleanup();
    render(<Harness misses={[]} save={vi.fn()} variant="light" />);
    expect(screen.queryByRole("list", { name: "Knowledge gaps" })).toBeNull();
  });

  it("saves nothing until the operator taps, then saves the edited text", async () => {
    const save = vi.fn(async () => ({ success: true }));
    render(<Harness misses={["Smith chinch bugs zoysia"]} save={save} />);
    expect(save).not.toHaveBeenCalled();
    expect(box()).toHaveValue("Smith chinch bugs zoysia");
    fireEvent.change(box(), { target: { value: "  chinch bugs   zoysia " } });
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    await waitFor(() => expect(screen.getByText(/Added to Monday's knowledge-gaps email/)).toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("chinch bugs zoysia", expect.stringMatching(UUID));
  });

  it("shows the error and locks the submitted text when the save fails", async () => {
    const save = vi.fn(async () => { throw new Error("Admin access required"); });
    render(<Harness misses={["chinch bugs"]} save={save} variant="light" />);
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Admin access required");
    expect(box()).toHaveValue("chinch bugs");
    expect(box()).toHaveAttribute("readonly");
  });

  it("a retry resends the same text under the same key, even after an edit attempt", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ success: true });
    render(<Harness misses={["chinch bugs"]} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    await screen.findByRole("alert");
    // The first save may have landed under this key, so an edit after it
    // must not change what the retry sends (or what the screen says saved).
    fireEvent.change(box(), { target: { value: "something else" } });
    expect(box()).toHaveValue("chinch bugs");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
    expect(await screen.findByText(/Added to Monday's knowledge-gaps email: "chinch bugs"/)).toBeInTheDocument();
  });

  it("closing and reopening the palette keeps the key, the locked text and the status", async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ success: true });
    render(<Harness misses={["Smith chinch bugs"]} save={save} />);
    fireEvent.change(box(), { target: { value: "chinch bugs" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    await screen.findByRole("alert");
    togglePalette();
    expect(screen.queryByRole("textbox", { name: "Knowledge gap" })).toBeNull();
    togglePalette();
    expect(box()).toHaveValue("chinch bugs");
    expect(box()).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]).toEqual(["chinch bugs", save.mock.calls[0][1]]);
    await screen.findByText(/Added to Monday's knowledge-gaps email: "chinch bugs"/);
    togglePalette();
    togglePalette();
    expect(screen.getByText(/Added to Monday's knowledge-gaps email: "chinch bugs"/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to knowledge gaps|Try again/ })).toBeNull();
  });

  it.each([
    ["after a save that landed", vi.fn(async () => ({ success: true })), /Added to Monday's knowledge-gaps email: "chinch bugs"/],
    ["after an ambiguous failed save", vi.fn(async () => { throw new Error("Network error"); }), /Network error/],
  ])("refreshing the same task keeps the box as it was %s", async (_label, save, shown) => {
    render(<Harness misses={["Smith chinch bugs"]} save={save} scope="task-1" />);
    fireEvent.change(box(), { target: { value: "chinch bugs" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    await screen.findByText(shown);
    const key = save.mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "refresh task" }));
    expect(screen.getByText(shown)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to knowledge gaps" })).toBeNull();
    const retry = screen.queryByRole("button", { name: "Try again" });
    if (retry) {
      expect(box()).toHaveValue("chinch bugs");
      fireEvent.click(retry);
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      expect(save.mock.calls[1]).toEqual(["chinch bugs", key]);
    }
  });

  it("a different task's payload starts fresh", async () => {
    const save = vi.fn(async () => ({ success: true }));
    render(<Harness misses={["chinch bugs"]} save={save} scope="task-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Add to knowledge gaps" }));
    await screen.findByText(/Added to Monday's knowledge-gaps email/);
    fireEvent.click(screen.getByRole("button", { name: "open other task" }));
    expect(screen.getByRole("button", { name: "Add to knowledge gaps" })).toBeInTheDocument();
  });

  it("disables the button when the text is under 3 characters", () => {
    render(<Harness misses={["chinch bugs"]} save={vi.fn()} />);
    fireEvent.change(box(), { target: { value: " a " } });
    expect(screen.getByRole("button", { name: "Add to knowledge gaps" })).toBeDisabled();
  });

  it("the mobile box is 16px so Safari does not zoom on focus", () => {
    render(<Harness misses={["chinch bugs"]} save={vi.fn()} variant="light" />);
    expect(box().style.fontSize).toBe("16px");
  });
});
