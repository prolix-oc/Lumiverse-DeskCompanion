import { identifier, MAX_QUESTION, record } from "./protocol";
import type { VoiceRef } from "./protocol";

export interface CompanionSettings {
  characterId: string;
  connectionId: string;
  deviceId: string;
  kind: "image" | "video";
  durationSeconds: number;
  historyTurns: number;
  mediaResolution: "inherit" | "unspecified" | "low" | "medium" | "high";
  optimizeMedia: boolean;
  optimizeMaxEdge: number;
  videoFps: number;
  videoBitrateKbps: number;
  imageFormat: "jpeg" | "webp" | "png";
  imageQuality: number;
  question: string;
  autoSpeak: boolean;
  voiceInput: boolean;
  sttProvider: "connection" | "whistle" | "webspeech";
  sttId: string;
  ttsId: string;
  voice: string;
  speed: number;
}

export const DEFAULT_SETTINGS: Readonly<CompanionSettings> = Object.freeze({
  characterId: "", connectionId: "", deviceId: "", kind: "image", durationSeconds: 3, historyTurns: 5,
  mediaResolution: "inherit",
  optimizeMedia: false, optimizeMaxEdge: 1280, videoFps: 15, videoBitrateKbps: 2500,
  imageFormat: "jpeg", imageQuality: 85,
  question: "", autoSpeak: false, voiceInput: false, sttProvider: "connection", sttId: "",
  ttsId: "", voice: "", speed: 1,
});

export type CompanionStage = "idle" | "listening" | "transcribing" | "checking" | "consent" | "optimizing" | "generating" | "cancelling";

export interface CompanionActivity {
  requestId: string | null;
  ownerClientId: string | null;
  stage: CompanionStage;
  text: string;
  characterName: string;
  voice: VoiceRef | null;
  message: string;
  error: boolean;
  speechStage: "idle" | "synthesizing" | "ready" | "playing";
  speechClientId: string | null;
  canFinish: boolean;
}

export interface CompanionSnapshot {
  shortcutsAvailable?: boolean;
  epoch: string;
  sequence: number;
  revision: number;
  settings: CompanionSettings;
  activity: CompanionActivity;
}

export function idleActivity(): CompanionActivity {
  return { requestId: null, ownerClientId: null, stage: "idle", text: "", characterName: "A fresh perspective", voice: null,
    message: "", error: false,
    speechStage: "idle", speechClientId: null, canFinish: false };
}

export function parseSettingsPatch(value: unknown): Partial<CompanionSettings> | null {
  if (!record(value) || Object.keys(value).length === 0 || Object.keys(value).length > Object.keys(DEFAULT_SETTINGS).length) return null;
  const patch: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return null;
    if (["characterId", "connectionId", "deviceId", "sttId", "ttsId"].includes(key)) {
      if (setting !== "" && !identifier(setting)) return null;
    } else if (key === "kind") {
      if (setting !== "image" && setting !== "video") return null;
    } else if (key === "sttProvider") {
      if (setting !== "connection" && setting !== "whistle" && setting !== "webspeech") return null;
    } else if (key === "mediaResolution") {
      if (typeof setting !== "string" || !["inherit", "unspecified", "low", "medium", "high"].includes(setting)) return null;
    } else if (key === "imageFormat") {
      if (typeof setting !== "string" || !["jpeg", "webp", "png"].includes(setting)) return null;
    } else if (["optimizeMaxEdge", "videoFps", "videoBitrateKbps", "imageQuality"].includes(key)) {
      const [min, max] = key === "optimizeMaxEdge" ? [256, 3840] : key === "videoFps" ? [1, 30]
        : key === "videoBitrateKbps" ? [128, 8000] : [1, 100];
      if (!Number.isInteger(setting) || Number(setting) < min! || Number(setting) > max!) return null;
    } else if (key === "autoSpeak" || key === "voiceInput" || key === "optimizeMedia") {
      if (typeof setting !== "boolean") return null;
    } else if (key === "question" || key === "voice") {
      if (typeof setting !== "string" || setting.length > (key === "question" ? MAX_QUESTION : 256)) return null;
    } else if (key === "historyTurns") {
      if (!Number.isSafeInteger(setting) || Number(setting) < 0) return null;
    } else if (typeof setting !== "number" || !Number.isFinite(setting)
      || (key === "speed" ? setting < 0.25 || setting > 4 : !Number.isInteger(setting) || setting < 1 || setting > 120)) return null;
    patch[key] = setting;
  }
  return patch;
}

export function parseSettings(value: unknown): CompanionSettings | null {
  // Retire the timed recorder setting while preserving existing opt-ins and provider choices.
  if (!record(value)) return null;
  const normalized = { ...value };
  if (Object.hasOwn(normalized, "voiceSeconds")) {
    if (!Number.isInteger(normalized.voiceSeconds) || Number(normalized.voiceSeconds) < 1 || Number(normalized.voiceSeconds) > 15) return null;
    delete normalized.voiceSeconds;
  }
  if (!Object.hasOwn(normalized, "sttProvider")) normalized.sttProvider = "connection";
  if (!Object.hasOwn(normalized, "historyTurns")) normalized.historyTurns = DEFAULT_SETTINGS.historyTurns;
  if (!Object.hasOwn(normalized, "mediaResolution")) normalized.mediaResolution = DEFAULT_SETTINGS.mediaResolution;
  for (const key of ["optimizeMedia", "optimizeMaxEdge", "videoFps", "videoBitrateKbps", "imageFormat", "imageQuality"] as const) {
    if (!Object.hasOwn(normalized, key)) normalized[key] = DEFAULT_SETTINGS[key];
  }
  const patch = parseSettingsPatch(normalized);
  return patch && Object.keys(patch).length === Object.keys(DEFAULT_SETTINGS).length ? { ...DEFAULT_SETTINGS, ...patch } : null;
}

export function supportsGeminiMediaResolution(provider: string, model: string): boolean {
  return ["google", "google_vertex"].includes(provider) && /(?:^|\/)gemini(?:[-/]|$)/i.test(model.trim());
}
