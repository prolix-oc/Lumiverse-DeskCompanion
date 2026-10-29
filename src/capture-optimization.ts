import type { CapturedMediaRef } from "lumiverse-spindle-types";
import type { CompanionSettings } from "./settings";

// Keep compatibility with installed SDKs/hosts predating desktop-capture-optimize-v1.
export type CaptureOptimization = { assetId: string; connectionId: string; userId: string } & (
  | { kind: "image"; maxEdge: number; format: "jpeg" | "webp" | "png"; quality: number }
  | { kind: "video"; maxEdge: number; fps: number; bitrateKbps: number }
);
export interface CaptureOptimizer { optimize?(input: CaptureOptimization): Promise<CapturedMediaRef> }

export function optimizationRequest(settings: CompanionSettings, capture: CapturedMediaRef, userId: string): CaptureOptimization {
  const common = { assetId: capture.assetId, connectionId: capture.connectionId, userId, maxEdge: settings.optimizeMaxEdge };
  return capture.kind === "image" ? { ...common, kind: "image", format: settings.imageFormat, quality: settings.imageQuality }
    : { ...common, kind: "video", fps: settings.videoFps, bitrateKbps: settings.videoBitrateKbps };
}
