import { identifier, MAX_QUESTION, record } from "./protocol";
import type { VoiceRef } from "./protocol";

export interface CompanionSettings {
  characterId: string;
  connectionId: string;
  deviceId: string;
  kind: "image" | "video";
  durationSeconds: number;
  question: string;
  autoSpeak: boolean;
  voiceInput: boolean;
  sttId: string;
  voiceSeconds: number;
  ttsId: string;
  voice: string;
  speed: number;
}

export const DEFAULT_SETTINGS: Readonly<CompanionSettings> = Object.freeze({
  characterId: "", connectionId: "", deviceId: "", kind: "image", durationSeconds: 3,
  question: "", autoSpeak: false, voiceInput: false, sttId: "", voiceSeconds: 5,
  ttsId: "", voice: "", speed: 1,
});

export type CompanionStage = "idle" | "listening" | "transcribing" | "checking" | "consent" | "generating" | "cancelling";

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
}

export interface CompanionSnapshot {
  epoch: string;
  sequence: number;
  revision: number;
  settings: CompanionSettings;
  activity: CompanionActivity;
}

export function idleActivity(): CompanionActivity {
  return { requestId: null, ownerClientId: null, stage: "idle", text: "", characterName: "A fresh perspective", voice: null,
    message: "Choose a source in the trusted native picker; review it and explicitly Share before a model sees it.", error: false,
    speechStage: "idle", speechClientId: null };
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
    } else if (key === "autoSpeak" || key === "voiceInput") {
      if (typeof setting !== "boolean") return null;
    } else if (key === "question" || key === "voice") {
      if (typeof setting !== "string" || setting.length > (key === "question" ? MAX_QUESTION : 256)) return null;
    } else if (typeof setting !== "number" || !Number.isFinite(setting)
      || (key === "speed" ? setting < 0.25 || setting > 4 : !Number.isInteger(setting) || setting < 1 || setting > (key === "voiceSeconds" ? 15 : 30))) return null;
    patch[key] = setting;
  }
  return patch;
}

export function parseSettings(value: unknown): CompanionSettings | null {
  const patch = parseSettingsPatch(value);
  return patch && Object.keys(patch).length === Object.keys(DEFAULT_SETTINGS).length ? { ...DEFAULT_SETTINGS, ...patch } : null;
}
