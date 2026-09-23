import { PartyPopper } from "lucide-react";
import { useUpdaterStore } from "../../stores/updater-store";
import { useTabStore } from "../../stores/tab-store";
import { ModalShell, BTN_GHOST, BTN_PRIMARY } from "../shared/ModalShell";

/*
 * Startup announcement shown when the running version differs from the last
 * version the user acknowledged. Offers a direct jump to the in-app changelog
 * screen; both actions mark the version as seen so the dialog appears only
 * once per update. Mounted after UpdateDialog in AppShell so it paints above
 * it when both would show on the same launch.
 */
export function UpdateAnnounceDialog() {
  const open = useUpdaterStore((s) => s.announceOpen);
  const appVersion = useUpdaterStore((s) => s.appVersion);
  const dismiss = useUpdaterStore((s) => s.dismissAnnounce);

  const showChangelog = () => {
    dismiss();
    useTabStore.getState().openPageTab("changelog", "What's new");
  };

  return (
    <ModalShell
      open={open && !!appVersion}
      onClose={dismiss}
      title="You're updated"
      icon={PartyPopper}
      maxWidth="sm"
      testId="update-announce-modal"
      footer={
        <>
          <button type="button" onClick={dismiss} className={BTN_GHOST}>
            Later
          </button>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <button
            autoFocus
            type="button"
            onClick={showChangelog}
            className={BTN_PRIMARY}
            data-testid="update-announce-changelog"
          >
            See what's new
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 no-select">
        <p className="text-[length:var(--text-sm)] text-text-secondary">
          OmniSSH has been updated to{" "}
          <span className="font-medium text-text-primary">v{appVersion}</span>.
        </p>
        <p className="text-[length:var(--text-sm)] text-text-secondary">
          See what changed — new features, improvements, and fixes in this
          release.
        </p>
      </div>
    </ModalShell>
  );
}
