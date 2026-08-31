import { describe, expect, it, vi } from "vitest";
import {
  closeExplorerSession,
  resolveExplorerTransport,
} from "./explorer-transport";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("explorer transport close dispatch", () => {
  it.each([
    ["sftp", { sftpSessionId: "session-1" }],
    ["scp", { scpSessionId: "session-1" }],
  ] as const)("closes %s with its transport-specific session key", async (transport, args) => {
    invoke.mockResolvedValue(undefined);

    await closeExplorerSession(transport, "session-1");

    expect(invoke).toHaveBeenCalledWith(`${transport}_close`, args);
    invoke.mockReset();
  });

  it("prefers session transport metadata over tab fallback metadata", () => {
    expect(resolveExplorerTransport({ transport: "scp" }, "sftp")).toBe("scp");
    expect(resolveExplorerTransport({}, "scp")).toBe("scp");
    expect(resolveExplorerTransport(undefined, undefined)).toBeUndefined();
  });
});
