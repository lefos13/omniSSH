import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ensureAutoCwdSync, _resetAutoCwdSync } from "../cwd-sync";
import type { HostConfig } from "../../types";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function hostConfig(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    host: "example.com",
    port: 22,
    username: "root",
    auth_method: { type: "password", password: "" },
    ...overrides,
  };
}

/** Decode the bytes passed to `ssh_send_input`. */
function sentText(callIndex = 0): string {
  const args = invoke.mock.calls[callIndex][1] as { data: number[] };
  return new TextDecoder().decode(new Uint8Array(args.data));
}

describe("ensureAutoCwdSync", () => {
  beforeEach(() => {
    invoke.mockClear();
    _resetAutoCwdSync();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("installs the OSC 7 reporter once per session", async () => {
    ensureAutoCwdSync("s1", hostConfig());
    ensureAutoCwdSync("s1", hostConfig());

    await vi.advanceTimersByTimeAsync(1500);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe("ssh_send_input");
    expect(sentText()).toContain("__anyscp_osc7");
    expect(sentText()).toContain("PROMPT_COMMAND");
  });

  it("uses the fish installer when the host's shell is fish", async () => {
    ensureAutoCwdSync("s2", hostConfig({ default_shell: "/usr/bin/fish" }));
    await vi.advanceTimersByTimeAsync(1500);

    expect(sentText()).toContain("--on-variable PWD");
    expect(sentText()).not.toContain("PROMPT_COMMAND");
  });

  it("installs separately for a different session", async () => {
    ensureAutoCwdSync("s3", hostConfig());
    ensureAutoCwdSync("s4", hostConfig());
    await vi.advanceTimersByTimeAsync(1500);

    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
