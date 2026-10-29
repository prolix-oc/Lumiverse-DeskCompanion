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
  about.innerHTML = `<div class="dc-launcher"><button class="dc-button" data-role="permissions" type="button">Grant permissions</button><button class="dc-button" data-role="show" type="button">Open widget</button></div><p class="dc-note" data-role="status" role="status" hidden></p>`;
  tab.root.append(about);
  const permissionButton = about.querySelector<HTMLButtonElement>('[data-role="permissions"]')!;
  const showButton = about.querySelector<HTMLButtonElement>('[data-role="show"]')!;
  const status = about.querySelector<HTMLElement>('[data-role="status"]')!;
  const launcher = about.querySelector<HTMLElement>(".dc-launcher")!;
  function notice(message: string): void { status.textContent = message; status.hidden = !message; }
  let disposed = false;
  let destroyWidget: (() => void) | null = null;
  let settingsView: ReturnType<typeof mountView> | null = null;
  async function show(): Promise<void> {
    try {
      const granted = await ctx.permissions.getGranted();
      if (disposed) return;
      permissionButton.hidden = REQUIRED_PERMISSIONS.every(permission => granted.includes(permission));
      if (!granted.includes("ui_panels")) {
        about.prepend(launcher);
        const destroy = destroyWidget; destroyWidget = null; destroy?.();
        settingsView?.dispose(); settingsView = null;
        notice("Grant UI Panels to configure your companion."); return;
      }
      if ((ctx.host.capabilities["frontend-session-origin-v1"] ?? 0) < 1 || !ctx.frontendSessionId) {
        notice("Update Lumiverse: Desk Companion requires document-scoped frontend session identity."); return;
      }
      if (!settingsView) {
        settingsView = mountView(ctx, about, { surface: "settings", openSettings: () => tab.activate() });
        settingsView.panel.querySelector(".dc-header")!.append(launcher);
      }
      if (destroyWidget) return;
      destroyWidget = mountCompanionWidget(ctx, undefined, () => tab.activate());
      notice("");
    } catch { if (!disposed) notice("Cannot open the widget. Check permissions and the host version."); }
  }
  const showHandler = () => { void show(); };
  const permissionHandler = () => {
    void ctx.permissions.request([...REQUIRED_PERMISSIONS, "screen_recording", "media"], { reason: "Enable an opt-in character desktop companion with optional Media access for voice transcription. Desktop can remember your capture source and approval." })
      .then(() => show()).catch(() => { if (!disposed) notice("Capture permissions require administrator or owner approval."); });
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
