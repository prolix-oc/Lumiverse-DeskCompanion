import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { mountCompanionWidget } from "./companion-widget";
import { mountView } from "./companion-view";
import { REQUIRED_PERMISSIONS, record } from "./protocol";
import { STYLES } from "./styles";

export function setup(ctx: SpindleFrontendContext): () => void {
  const removeStyle = ctx.dom.addStyle(STYLES);
  const tab = ctx.ui.registerDrawerTab({ id: "desk-companion", title: "Desk Companion", shortName: "Companion",
    description: "Configure your permissioned desktop companion", keywords: ["desktop", "capture", "character", "voice", "popout", "settings", "configuration"] });
  const about = document.createElement("section");
  about.className = "dc-about";
  about.innerHTML = `<h2>A character beside your desktop</h2><p>Choose your character, model, desktop, and optional speech once. Then use Look at my screen or a desktop keyboard shortcut whenever you want a reaction. Configure shortcuts below, including an option to skip voice input. Your settings follow you into native pop-outs.</p>
    <details><summary>First-time setup &amp; desktop controls</summary>
    <ol><li>Grant UI Panels, Characters, Generation, and the capture permissions.</li><li>Use Set Up Screen Capture in the extension's permissions, or Enable Extension Screen Capture in Lumiverse Desktop's Browser tray menu. Sign in natively for the same account.</li><li>Choose your character, model, and desktop below. Connected desktops appear automatically. Configure Share workflow for optional timed voice input and automatic speech.</li><li>On the first share, choose a source in Desktop. Enable Remember this source and approval for this extension to reuse it on later matching shares. Review Before Sending is optional. Your character reacts and, when configured, speaks.</li></ol>
    <p>To make a system floating pop-out, use the widget's host-provided desktop pop-out control or the desktop tray's Floating Widgets menu. The extension does not create its own browser windows or call native capture IPC.</p>
    <p>Video currently requires a Gemini-compatible route. Linux capture and rolling replay buffers are not available yet. Use native Stop &amp; Discard to stop a pending capture; this also pauses future requests until Allow Screen Capture Requests Again in the desktop tray. Forget Screen Capture Approvals lets you choose a new source on your next share.</p></details>
    <div class="dc-row"><button data-role="permissions" type="button">Grant permissions</button><button data-role="show" type="button">Open companion widget</button></div><p data-role="status" role="status"></p>`;
  tab.root.append(about);
  const permissionButton = about.querySelector<HTMLButtonElement>('[data-role="permissions"]')!;
  const showButton = about.querySelector<HTMLButtonElement>('[data-role="show"]')!;
  const status = about.querySelector<HTMLElement>('[data-role="status"]')!;
  let disposed = false;
  let destroyWidget: (() => void) | null = null;
  let settingsView: ReturnType<typeof mountView> | null = null;
  async function show(): Promise<void> {
    try {
      const granted = await ctx.permissions.getGranted();
      if (disposed) return;
      if (!granted.includes("ui_panels")) {
        const destroy = destroyWidget; destroyWidget = null; destroy?.();
        settingsView?.dispose(); settingsView = null;
        status.textContent = "Grant UI Panels before opening the widget."; return;
      }
      if ((ctx.host.capabilities["frontend-session-origin-v1"] ?? 0) < 1 || !ctx.frontendSessionId) {
        status.textContent = "Update Lumiverse's frontend: this demo requires document-scoped frontend session identity."; return;
      }
      if (!settingsView) settingsView = mountView(ctx, about, { surface: "settings", openSettings: () => tab.activate() });
      if (destroyWidget) return;
      destroyWidget = mountCompanionWidget(ctx, undefined, () => tab.activate());
      status.textContent = "The companion widget is registered. Desktop pop-outs use the host's Floating Widgets controls.";
    } catch { if (!disposed) status.textContent = "Cannot open the widget. Check permissions and the host version."; }
  }
  const showHandler = () => { void show(); };
  const permissionHandler = () => {
    void ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording"], { reason: "Enable an opt-in character desktop companion. Desktop asks for native approval and can remember your source for later shares." })
      .then(() => show()).catch(() => { if (!disposed) status.textContent = "Permissions were not granted. Capture permissions require administrator/owner approval."; });
  };
  showButton.addEventListener("click", showHandler);
  permissionButton.addEventListener("click", permissionHandler);
  const unsubscribePermissions = ctx.events.on("SPINDLE_PERMISSION_CHANGED", (payload) => {
    if (!disposed && record(payload) && payload.extensionId === ctx.host.extensionInstallationId) void show();
  });
  void show();
  return () => {
    if (disposed) return;
    disposed = true; destroyWidget?.(); destroyWidget = null;
    settingsView?.dispose(); settingsView = null;
    unsubscribePermissions();
    showButton.removeEventListener("click", showHandler); permissionButton.removeEventListener("click", permissionHandler);
    about.replaceChildren(); tab.destroy(); removeStyle();
  };
}
