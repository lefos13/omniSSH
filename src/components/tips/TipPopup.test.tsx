import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TipPopup } from "./TipPopup";
import { TIPS } from "./tips";
import { useSettingsStore } from "../../stores/settings-store";
import { useToastStore } from "../../stores/toast-store";
import { useUpdaterStore } from "../../stores/updater-store";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

async function renderAndSettle() {
  render(<TipPopup />);
  await act(async () => {
    vi.advanceTimersByTime(3000);
  });
}

describe("TipPopup", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.useFakeTimers();
    useSettingsStore.setState({ loaded: true, tipIndex: 0 });
    useToastStore.setState({ toasts: [] });
    useUpdaterStore.setState({ announceOpen: false, dialogOpen: false });
  });

  it("shows the tip at the persisted index after the startup delay", async () => {
    await renderAndSettle();

    expect(screen.getByTestId("tip-popup")).toBeInTheDocument();
    expect(screen.getByText(TIPS[0].title)).toBeInTheDocument();
  });

  it("advances the rotation index so the next launch shows another tip", async () => {
    await renderAndSettle();

    expect(useSettingsStore.getState().tipIndex).toBe(1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).toHaveBeenCalledWith("save_setting", {
      key: "app_tip_index",
      value: "1",
    });
  });

  it("does not appear before the startup delay elapses", async () => {
    render(<TipPopup />);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.queryByTestId("tip-popup")).not.toBeInTheDocument();
  });

  it("stays hidden until settings have loaded", async () => {
    useSettingsStore.setState({ loaded: false });
    render(<TipPopup />);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByTestId("tip-popup")).not.toBeInTheDocument();
  });

  it("hides while a toast is on screen", async () => {
    useToastStore.setState({ toasts: [{ id: "t1", kind: "info", message: "hello" }] });
    await renderAndSettle();

    expect(screen.queryByTestId("tip-popup")).not.toBeInTheDocument();
  });

  it("hides while the update announcement modal is open", async () => {
    useUpdaterStore.setState({ announceOpen: true });
    await renderAndSettle();

    expect(screen.queryByTestId("tip-popup")).not.toBeInTheDocument();
  });

  it("dismisses permanently when the close button is clicked", async () => {
    await renderAndSettle();

    fireEvent.click(screen.getByTestId("tip-dismiss"));

    expect(screen.queryByTestId("tip-popup")).not.toBeInTheDocument();
  });

  it("steps forward through tips with the next button", async () => {
    await renderAndSettle();

    expect(screen.getByTestId("tip-counter")).toHaveTextContent(`Tip 1 / ${TIPS.length}`);
    fireEvent.click(screen.getByTestId("tip-next"));
    expect(screen.getByText(TIPS[1].title)).toBeInTheDocument();
    expect(screen.getByTestId("tip-counter")).toHaveTextContent(`Tip 2 / ${TIPS.length}`);
  });

  it("steps backward and wraps from the first tip to the last", async () => {
    await renderAndSettle();

    fireEvent.click(screen.getByTestId("tip-prev"));

    expect(screen.getByText(TIPS[TIPS.length - 1].title)).toBeInTheDocument();
    expect(screen.getByTestId("tip-counter")).toHaveTextContent(
      `Tip ${TIPS.length} / ${TIPS.length}`,
    );
  });

  it("wraps forward past the last tip back to the first", async () => {
    useSettingsStore.setState({ loaded: true, tipIndex: TIPS.length - 1 });
    await renderAndSettle();

    fireEvent.click(screen.getByTestId("tip-next"));

    expect(screen.getByText(TIPS[0].title)).toBeInTheDocument();
    expect(screen.getByTestId("tip-counter")).toHaveTextContent(`Tip 1 / ${TIPS.length}`);
  });

  it("browses locally without persisting the rotation index again", async () => {
    await renderAndSettle();

    fireEvent.click(screen.getByTestId("tip-next"));
    fireEvent.click(screen.getByTestId("tip-prev"));

    const tipSaves = invoke.mock.calls.filter(
      ([cmd, args]) => cmd === "save_setting" && (args as { key?: string }).key === "app_tip_index",
    );
    expect(tipSaves).toHaveLength(1);
    expect(tipSaves[0][1]).toMatchObject({ value: "1" });
  });
});
