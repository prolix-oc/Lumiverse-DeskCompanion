import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { mountCompanionWidget } from "./companion-widget";
import { REQUIRED_PERMISSIONS } from "./protocol";
import { STYLES } from "./styles";

export function setup(ctx: SpindleFrontendContext): () => void {
  const removeStyle = ctx.dom.addStyle(STYLES);
  const tab = ctx.ui.registerDrawerTab({ id: "desk-companion", title: "Desk Companion", shortName: "Companion",
    description: "Bring a character into a permissioned desktop sidecar", keywords: ["desktop", "capture", "character", "voice", "popout"] });
  const about = document.createElement("section");
  about.className = "dc-about";
  about.innerHTML = `<h2>A character beside your desktop</h2><p>Your selected character reacts naturally to a screenshot or short video you explicitly approve, drawing on their character card's personality and voice. Leave the question blank for a brief conversational reaction, or give them something specific to respond to. No background monitoring, no computer control, and no chat-history writes.</p>
    <ol><li>Grant UI Panels, Characters, Generation, and the capture permissions.</li><li>Enable Extension Screen Capture in Lumiverse Desktop's Browser tray menu, and sign in natively.</li><li>Choose your character, model, and desktop. Configure Share workflow for optional timed voice input and automatic speech.</li><li>Start one share, select the screen in the trusted picker, preview, and approve it. The character reacts and, when configured, speaks without a separate generation or TTS button.</li></ol>
    <p>To make a system floating pop-out, use the widget's host-provided desktop pop-out control or the desktop tray's Floating Widgets menu. The extension does not create its own browser windows or call native capture IPC.</p>
    <p>Video currently requires a Gemini-compatible route. Linux capture and rolling replay buffers are not available yet. Cancelling a worker request does not dismiss a pending native picker: use its Stop &amp; Discard button.</p>
    <div class="dc-row"><button data-role="permissions" type="button">Grant permissions</button><button data-role="show" type="button">Open companion widget</button></div><p data-role="status" role="status"></p>`;
  tab.root.append(about);
  const permissionButton = about.querySelector<HTMLButtonElement>('[data-role="permissions"]')!;
  const showButton = about.querySelector<HTMLButtonElement>('[data-role="show"]')!;
  const status = about.querySelector<HTMLElement>('[data-role="status"]')!;
  let disposed = false;
  let destroyWidget: (() => void) | null = null;
  async function show(): Promise<void> {
    try {
      const granted = await ctx.permissions.getGranted();
      if (disposed || destroyWidget) return;
      if (!granted.includes("ui_panels")) { status.textContent = "Grant UI Panels before opening the widget."; return; }
      if ((ctx.host.capabilities["frontend-session-routing-v1"] ?? 0) < 1 || !ctx.frontendSessionId) {
        status.textContent = "Update Lumiverse: this demo requires document-targeted frontend session routing."; return;
      }
      destroyWidget = mountCompanionWidget(ctx);
      status.textContent = "The companion widget is registered. Desktop pop-outs use the host's Floating Widgets controls.";
    } catch { if (!disposed) status.textContent = "Cannot open the widget. Check permissions and the host version."; }
  }
  const showHandler = () => { void show(); };
  const permissionHandler = () => {
    void ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording"], { reason: "Enable an opt-in character desktop companion. Each capture still requires native source selection, preview, and Share." })
      .then(() => show()).catch(() => { if (!disposed) status.textContent = "Permissions were not granted. Capture permissions require administrator/owner approval."; });
  };
  showButton.addEventListener("click", showHandler);
  permissionButton.addEventListener("click", permissionHandler);
  void show();
  return () => {
    if (disposed) return;
    disposed = true; destroyWidget?.(); destroyWidget = null;
    showButton.removeEventListener("click", showHandler); permissionButton.removeEventListener("click", permissionHandler);
    about.replaceChildren(); tab.destroy(); removeStyle();
  };
}
