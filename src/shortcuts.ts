import type { SpindleCommandDTO } from "lumiverse-spindle-types";

export const SHARE_COMMAND = "share-screen";
export const QUICK_SHARE_COMMAND = "share-screen-without-voice";
export const CAPTURE_COMMANDS: SpindleCommandDTO[] = [
  { id: SHARE_COMMAND, label: "Desk Companion: Share screen", description: "Share using your saved settings. Press again during video capture to finish and send the clip.", keywords: ["desktop", "capture", "companion", "voice"], scope: "global" },
  { id: QUICK_SHARE_COMMAND, label: "Desk Companion: Share screen without voice input", description: "Skip microphone input for this share. Press again during video capture to finish and send the clip.", keywords: ["desktop", "capture", "companion", "quick"], scope: "global" },
];

// The host advertises command-session-routing-v1 for this optional callback
// argument. 0.6.69's two-argument callback remains compatible with older hosts.
export interface CommandOrigin { userId: string; frontendSessionId?: string }
