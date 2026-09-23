import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateAnnounceDialog } from "./UpdateAnnounceDialog";
import { useUpdaterStore } from "../../stores/updater-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useTabStore, pageTabId } from "../../stores/tab-store";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("UpdateAnnounceDialog", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useUpdaterStore.setState({ appVersion: "2.0.0", announceOpen: false, dialogOpen: false });
    useSettingsStore.setState({ seenVersion: "1.0.0" });
    useTabStore.setState({
      tabs: new Map([
        [
          pageTabId("hosts"),
          { type: "page", id: pageTabId("hosts"), label: "Hosts", page: "hosts" as const },
        ],
      ]),
      tabOrder: [pageTabId("hosts")],
      activeTabId: pageTabId("hosts"),
    });
  });

  it("stays closed while the seen version matches the running version", async () => {
    useSettingsStore.setState({ seenVersion: "2.0.0" });
    await useUpdaterStore.getState().maybeAnnounceUpdate();

    render(<UpdateAnnounceDialog />);
    expect(screen.queryByTestId("update-announce-modal")).not.toBeInTheDocument();
  });

  it("opens when the app was updated since the last launch", async () => {
    await useUpdaterStore.getState().maybeAnnounceUpdate();

    render(<UpdateAnnounceDialog />);
    expect(screen.getByTestId("update-announce-modal")).toBeInTheDocument();
    expect(screen.getByText(/OmniSSH has been updated to/)).toHaveTextContent("v2.0.0");
  });

  it("stays silent and seeds the seen version on the very first run", async () => {
    useSettingsStore.setState({ seenVersion: null });
    await useUpdaterStore.getState().maybeAnnounceUpdate();

    expect(useSettingsStore.getState().seenVersion).toBe("2.0.0");
    expect(useUpdaterStore.getState().announceOpen).toBe(false);

    render(<UpdateAnnounceDialog />);
    expect(screen.queryByTestId("update-announce-modal")).not.toBeInTheDocument();
  });

  it("'See what's new' marks the version seen and opens the changelog tab", async () => {
    await useUpdaterStore.getState().maybeAnnounceUpdate();
    render(<UpdateAnnounceDialog />);

    fireEvent.click(screen.getByTestId("update-announce-changelog"));

    expect(screen.queryByTestId("update-announce-modal")).not.toBeInTheDocument();
    expect(useSettingsStore.getState().seenVersion).toBe("2.0.0");
    expect(useTabStore.getState().activeTabId).toBe(pageTabId("changelog"));
    expect(useTabStore.getState().tabs.get(pageTabId("changelog"))).toMatchObject({
      type: "page",
      page: "changelog",
    });
  });

  it("'Later' still marks the version seen so the dialog does not reappear", async () => {
    await useUpdaterStore.getState().maybeAnnounceUpdate();
    render(<UpdateAnnounceDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    expect(screen.queryByTestId("update-announce-modal")).not.toBeInTheDocument();
    await waitFor(() => expect(useSettingsStore.getState().seenVersion).toBe("2.0.0"));
    expect(useTabStore.getState().activeTabId).toBe(pageTabId("hosts"));
  });
});
