/*
 * Curated usage tips shown in the bottom-right tip card, one per app launch.
 * Kept as data (not hardcoded in the component) so tips can be added or
 * reordered freely; TipPopup rotates through them via the persisted
 * `app_tip_index` counter. Every tip must describe behavior that actually
 * exists — verify against the code before adding one.
 */
export interface Tip {
  id: string;
  title: string;
  body: string;
}

export const TIPS: Tip[] = [
  {
    id: "snippet-palette",
    title: "Run snippets in a keystroke",
    body: "Press ⌘K (Ctrl+K on Windows/Linux) anywhere to open the snippet palette and fire a saved snippet into the active terminal.",
  },
  {
    id: "split-terminals",
    title: "Split your terminal",
    body: "Open a host in split view to get two terminals side by side — handy for watching logs while you work.",
  },
  {
    id: "linked-explorer",
    title: "File tree follows your shell",
    body: "The linked explorer panel follows the shell's current directory as you cd, so the file list always matches your terminal. Toggle follow mode off to browse freely.",
  },
  {
    id: "port-forwarding",
    title: "Tunnels without a config file",
    body: "The Port Forwarding page sets up local and remote tunnels in a couple of clicks — no SSH config editing needed.",
  },
  {
    id: "external-editors",
    title: "Edit remote files locally",
    body: "Set your favorite editor in Settings ▸ External Editors, then double-click a remote file to open it in your local IDE.",
  },
  {
    id: "highlights",
    title: "Highlight what matters",
    body: "Add keyword highlight rules in Settings ▸ Terminal to light up errors, deploy results, or anything you always scan for.",
  },
  {
    id: "paste-button",
    title: "Safer pasting",
    body: "Multi-line pastes can trigger shell warnings. Settings ▸ Terminal lets you paste with a middle or right click instead of ⌘V.",
  },
  {
    id: "grouped-hosts",
    title: "Tidy up your dashboard",
    body: "Switch the dashboard to grouped or list view (cards, list, or grouped) to keep a growing host collection manageable.",
  },
  {
    id: "transfers",
    title: "Watch your transfers",
    body: "The Transfers page shows every upload and download with progress, and Settings lets you tune how many run in parallel.",
  },
  {
    id: "vault",
    title: "Keep passwords out of plain sight",
    body: "The encrypted App Vault stores host passwords locally instead of the system keychain — set it up in Settings ▸ Security & Vault.",
  },
  {
    id: "effect-themes",
    title: "Animated backgrounds",
    body: "Themes like Matrix, Embers, and Lava add animated backgrounds — each has its own floating controls panel for palette, speed, and density.",
  },
  {
    id: "s3",
    title: "S3-compatible storage",
    body: "The explorer isn't just SFTP — connect an S3-compatible bucket (MinIO, R2, Wasabi) and browse it with the same file UI.",
  },
];
