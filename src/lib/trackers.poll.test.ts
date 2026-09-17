/* Polling + parsing contract for the tracker layer: interval JSON polling
 * of docker stats, health metrics, and pm2 process lists. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { execOnSession, detectTracker, resolveActionCommand, TRACKERS } from "./trackers";

function dockerStatsLine(name: string, cpu: string, mem: string): string {
  return JSON.stringify({ Name: name, CPUPerc: cpu, MemUsage: mem });
}

function parseDockerStats(stdout: string): { name: string; cpu: string; mem: string }[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const o = JSON.parse(l) as { Name: string; CPUPerc: string; MemUsage: string };
      return { name: o.Name, cpu: o.CPUPerc, mem: o.MemUsage };
    });
}

function parseMemLine(stdout: string): { used: number; total: number } | null {
  const line = stdout.split("\n").find((l) => l.startsWith("Mem:"));
  if (!line) return null;
  const parts = line.split(/\s+/);
  return { used: Number(parts[2]), total: Number(parts[1]) };
}

describe("tracker polling", () => {
  beforeEach(() => invokeMock.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  it("parses docker stats JSON lines, skipping blanks", () => {
    const out = `${dockerStatsLine("web", "1.2%", "10MiB / 1GiB")}\n\n${dockerStatsLine("db", "0.3%", "200MiB / 2GiB")}\n`;
    expect(parseDockerStats(out)).toEqual([
      { name: "web", cpu: "1.2%", mem: "10MiB / 1GiB" },
      { name: "db", cpu: "0.3%", mem: "200MiB / 2GiB" },
    ]);
  });

  it("parses free -m Mem line", () => {
    expect(parseMemLine("Mem: 7976 1234 5000 0 1741 6400\n")).toEqual({ used: 1234, total: 7976 });
    expect(parseMemLine("nothing here")).toBeNull();
  });

  it("computes health percentages from nproc + load + free + df", () => {
    const stdout = [
      "4",
      "---",
      "1.00 0.50 0.25 1/200 123",
      "---",
      "              total        used        free      shared  buff/cache   available",
      "Mem:           7976        3988        1000         100        2988        3700",
      "Swap:          2048           0        2048",
      "---",
      "Filesystem     1024-blocks      Used Available Capacity Mounted on",
      "/dev/vda1        36791808  29433446   5462434      85% /",
      "---",
      "up 3 days",
    ].join("\n");
    const sections = stdout.split("---").map((s) => s.trim());
    const cpus = parseInt(sections[0]?.split(/\s+/)[0] ?? "", 10) || null;
    expect(cpus).toBe(4);
    const load1 = sections[1]?.split(/\s+/)[0] ?? "?";
    expect(Math.round((parseFloat(load1) / (cpus ?? 1)) * 100)).toBe(25);
    const memLine = sections[2].split("\n").find((l) => l.startsWith("Mem:")) ?? "";
    const memParts = memLine.split(/\s+/);
    expect(Math.round((Number(memParts[2]) / Number(memParts[1])) * 100)).toBe(50);
    const dfLine = sections[3].split("\n").find((l) => l.includes(" /")) ?? "";
    expect(dfLine.split(/\s+/).find((p) => p.endsWith("%"))).toBe("85%");
  });

  it("parses pm2 jlist array", () => {
    const procs = JSON.parse(`[{"name":"api","pm2_env":{"status":"online"}}]`) as { name: string }[];
    expect(procs.map((p) => p.name)).toEqual(["api"]);
  });

  it("rejects empty poll output without throwing", () => {
    expect(parseDockerStats("")).toEqual([]);
    expect(parseDockerStats("   \n  \n")).toEqual([]);
  });

  it("execOnSession invokes ssh_exec_command and returns the result", async () => {
    invokeMock.mockResolvedValue({ stdout: "ok\n", stderr: "", exitCode: 0 });
    const command = "docker ps --format '{{json .}}'";
    const result = await execOnSession("sess-1", command);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0] as [string, { sessionId: string; command: string }];
    expect(cmd).toBe("ssh_exec_command");
    expect(args.sessionId).toBe("sess-1");
    expect(args.command.endsWith(command)).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("execOnSession blocks cleanup commands before IPC", async () => {
    await expect(execOnSession("sess-1", "docker system prune -f")).rejects.toThrow(/allowlist/);
    await expect(execOnSession("sess-1", "rm -rf /var/log/x")).rejects.toThrow(/allowlist/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("detectTracker reports docker present vs absent", async () => {
    const docker = TRACKERS.find((t) => t.id === "docker")!;
    invokeMock.mockResolvedValue({ stdout: "0\n", stderr: "", exitCode: 0 });
    await expect(detectTracker("s", docker)).resolves.toBe(true);
    invokeMock.mockResolvedValue({ stdout: "1\n", stderr: "", exitCode: 0 });
    await expect(detectTracker("s", docker)).resolves.toBe(false);
  });

  it("resolveActionCommand quotes values so names cannot escape the shell", () => {
    expect(resolveActionCommand("docker restart {name}", { name: "web; rm -rf /" })).toBe(
      "docker restart 'web; rm -rf /'",
    );
  });
});
