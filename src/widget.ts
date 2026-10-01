import type { SpindleFrontendContext, SpindleFrontendWidgetTarget } from "lumiverse-spindle-types";
import { mountCompanionWidget } from "./companion-widget";

export function setupWidget(ctx: SpindleFrontendContext, target: SpindleFrontendWidgetTarget): () => void {
  if (target.index !== 0) throw new Error("Desk Companion registers exactly one floating widget.");
  return mountCompanionWidget(ctx, target);
}
