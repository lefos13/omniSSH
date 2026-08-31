import { X } from "lucide-react";
import { useSftpStore } from "../../stores/sftp-store";
import { useTabStore } from "../../stores/tab-store";
import { closeExplorerSession, resolveExplorerTransport } from "../../lib/explorer-transport";

export function SftpTabs() {
  const sessions = useSftpStore((s) => s.sessions);
  const activeSftpSessionId = useSftpStore((s) => s.activeSftpSessionId);
  const setActiveSftpSession = useSftpStore((s) => s.setActiveSftpSession);
  const closeSession = useSftpStore((s) => s.closeSession);

  if (sessions.size === 0) return null;

  const sessionList = Array.from(sessions.values());

  const handleClose = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const session = useSftpStore.getState().sessions.get(id);
      const tab = useTabStore.getState().tabs.get(id);
      const tabTransport = tab?.type === "sftp" ? tab.transport : undefined;
      const transport = resolveExplorerTransport(session, tabTransport) ?? "sftp";
      await closeExplorerSession(transport, id);
    } catch {
      // Already closed
    }
    closeSession(id);
  };

  const handleTabKeyDown = (id: string, e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActiveSftpSession(id);
    }
  };

  /* Each item keeps the tab and close actions as sibling native controls under
   * a neutral wrapper, avoiding an interactive descendant inside role="tab";
   * the active tab alone remains in the normal keyboard tab sequence. */
  return (
    <div className="flex items-end h-[var(--tabbar-height)] bg-bg-surface border-b border-border no-select px-1.5">
      <div
        className="flex items-end gap-1 overflow-x-auto flex-1 min-w-0 pb-0"
        role="tablist"
        aria-label="Open SFTP sessions"
      >
        {sessionList.map((session) => {
          const isActive = session.sftpSessionId === activeSftpSessionId;

          return (
            <div
              key={session.sftpSessionId}
              className={[
                "group relative flex items-center gap-2 px-3.5 h-[34px] shrink-0 max-w-[220px]",
                "text-[length:var(--text-sm)] leading-none rounded-t-lg cursor-pointer",
                "transition-[color,background-color,box-shadow] duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                isActive
                  ? "bg-bg-base text-text-primary shadow-[0_-1px_0_0_var(--color-border),1px_0_0_0_var(--color-border),-1px_0_0_0_var(--color-border)]"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-base/30",
              ].join(" ")}
            >
              <button
                type="button"
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                data-testid={`sftp-tab-${session.sftpSessionId}`}
                onClick={() => setActiveSftpSession(session.sftpSessionId)}
                onKeyDown={(e) => handleTabKeyDown(session.sftpSessionId, e)}
                title={session.label}
                className="min-w-0 flex-1 h-full truncate text-left text-inherit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className={`truncate ${isActive ? "font-medium" : ""}`}>
                  {session.label}
                </span>
              </button>

              <button
                type="button"
                data-testid={`sftp-tab-${session.sftpSessionId}-close`}
                onClick={(e) => void handleClose(session.sftpSessionId, e)}
                className={[
                  "ml-auto p-1 -mr-1 rounded shrink-0",
                  "text-text-muted hover:text-text-primary hover:bg-bg-muted",
                  isActive ? "opacity-50 group-hover:opacity-100" : "opacity-0 group-hover:opacity-100",
                  "transition-all duration-[var(--duration-fast)]",
                  "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                ].join(" ")}
                aria-label={`Close ${session.label}`}
                tabIndex={0}
              >
                <X size={13} strokeWidth={2} aria-hidden="true" />
              </button>

              {isActive && (
                <span
                  className="absolute -bottom-px left-0 right-0 h-px bg-bg-base"
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
