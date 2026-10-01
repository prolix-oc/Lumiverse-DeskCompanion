import type { SpindleFrontendContext, SpindleFrontendWidgetTarget } from "lumiverse-spindle-types";
import { mountView } from "./companion-view";
import { STYLES } from "./styles";
import { record } from "./protocol";

export function mountCompanionWidget(ctx: SpindleFrontendContext, target?: SpindleFrontendWidgetTarget, openSettings?: () => void): () => void {
  if ((ctx.host.capabilities["frontend-session-origin-v1"] ?? 0) < 1 || !ctx.frontendSessionId) {
    throw new Error("Desk Companion requires document-scoped frontend session identity.");
  }
  const removeStyle = ctx.dom.addStyle(STYLES);
  let widget: ReturnType<SpindleFrontendContext["ui"]["createFloatWidget"]> | null = null;
  try {
    const mounted = ctx.ui.createFloatWidget({ width: target?.width ?? 410, height: target?.height ?? 460,
      initialPosition: { x: 24, y: 72 }, snapToEdge: true, tooltip: "Desk Companion", chromeless: target?.chromeless ?? false });
    widget = mounted;
    Object.assign(mounted.root.style, { width: "100%", height: "100%", minHeight: "0", overflow: "hidden" });
    const view = mountView(ctx, mounted.root, { surface: "widget", openSettings });
    const returned = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      if (record(detail) && detail.extensionId === ctx.host.extensionInstallationId
        && (detail.widgetId === undefined || detail.widgetId === mounted.widgetId)) mounted.root.append(view.panel);
    };
    window.addEventListener("spindle:desktop-widget-returned", returned);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener("spindle:desktop-widget-returned", returned);
      try { view.dispose(); } finally { try { mounted.destroy(); } finally { removeStyle(); } }
    };
  } catch (error) {
    try { widget?.destroy(); } finally { removeStyle(); }
    throw error;
  }
}
