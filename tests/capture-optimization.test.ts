import { expect, test } from "bun:test";
import { CHANNEL } from "../src/protocol";
import { DEFAULT_SETTINGS, parseSettings, parseSettingsPatch } from "../src/settings";
import { installCompanion } from "../src/worker";
import { deferred, fixture, settle } from "./fixtures";

test("existing settings migrate with optimization disabled and strict format/range validation", () => {
  const { optimizeMedia, optimizeMaxEdge, videoFps, videoBitrateKbps, imageFormat, imageQuality, ...old } = DEFAULT_SETTINGS;
  expect(parseSettings(old)).toEqual(DEFAULT_SETTINGS);
  expect(parseSettingsPatch({ optimizeMedia: true, optimizeMaxEdge: 256, videoFps: 30, videoBitrateKbps: 8000, imageFormat: "png", imageQuality: 100 })).not.toBeNull();
  for (const patch of [{ optimizeMedia: "true" }, { optimizeMaxEdge: 255 }, { optimizeMaxEdge: 3841 }, { videoFps: 0 },
    { videoFps: 31 }, { videoFps: 2.5 }, { videoBitrateKbps: 127 }, { videoBitrateKbps: 8001 }, { imageFormat: "svg" },
    { imageQuality: 0 }, { imageQuality: 101 }, { imageQuality: NaN }, { imageQuality: "85" }]) {
    expect(parseSettingsPatch(patch)).toBeNull();
  }
});

async function configure(host: ReturnType<typeof fixture>, patch: Record<string, unknown>) {
  host.emit({ channel: CHANNEL, clientId: "client-a", id: "subscribe-a", type: "subscribe", surface: "settings" }); await settle();
  host.emit({ channel: CHANNEL, clientId: "client-a", id: "settings-a", type: "configure", patch }); await settle();
}

test("opt-in optimization uses saved image/video options, trusted ownership and the same private generation handle", async () => {
  for (const kind of ["image", "video"] as const) {
    const host = fixture(); Object.assign(host.mutable.host.capabilities, { "desktop-capture-optimize-v1": 1 });
    const dispose = installCompanion(host.api);
    try {
      await configure(host, { optimizeMedia: true, optimizeMaxEdge: 960, videoFps: 12, videoBitrateKbps: 1800, imageFormat: "webp", imageQuality: 75 });
      host.emit(host.message("observe-a", { kind, userId: "attacker" })); await settle();
      expect(host.optimized).toEqual([{ assetId: host.capture.assetId, connectionId: host.connection.id, userId: "user-a", kind, maxEdge: 960,
        ...(kind === "video" ? { fps: 12, bitrateKbps: 1800 } : { format: "webp", quality: 75 }) }]);
      expect(host.sent.find(m => m.payload.stage === "optimizing")?.payload).toMatchObject({ type: "status", canFinish: false });
      expect(host.generations).toHaveLength(1);
      expect(host.generations[0].messages.at(-1).content.at(-1)).toEqual({ type: "desktop_capture", asset_id: host.capture.assetId });
      expect(host.generations[0].reasoning).toEqual({ source: "inherit" });
      expect(host.sent.find(m => m.payload.type === "complete")?.payload).toMatchObject({ type: "complete", capture: { width: 640, height: 360 } });
      expect(JSON.stringify(host.sent)).not.toContain(host.capture.assetId);
      expect(host.released).toHaveLength(1);
    } finally { dispose(); }
  }
});

test("optimization off keeps the original path; an unsupported enabled host fails before capture", async () => {
  for (const enabled of [false, true]) {
    const host = fixture(); const dispose = installCompanion(host.api);
    try {
      await configure(host, { optimizeMedia: enabled }); host.emit(host.message()); await settle();
      expect(host.optimized).toHaveLength(0);
      expect(host.requests).toHaveLength(enabled ? 0 : 1);
      expect(host.generations).toHaveLength(enabled ? 0 : 1);
      if (enabled) expect(host.sent.find(m => m.payload.type === "error")?.payload).toMatchObject({ type: "error", code: "OPTIMIZATION_UNSUPPORTED" });
    } finally { dispose(); }
  }
});

test("conversion failure is safe and never sends the unoptimized media as a fallback", async () => {
  const host = fixture(); Object.assign(host.mutable.host.capabilities, { "desktop-capture-optimize-v1": 1 });
  host.mutable.desktop.capture.optimize = async () => { throw new Error("SECRET ffmpeg credentials and paths"); };
  const dispose = installCompanion(host.api);
  try {
    await configure(host, { optimizeMedia: true }); host.emit(host.message()); await settle();
    expect(host.generations).toHaveLength(0); expect(host.released).toHaveLength(1);
    expect(host.sent.find(m => m.payload.type === "error")?.payload).toMatchObject({ type: "error", code: "OPTIMIZATION_FAILED" });
    expect(JSON.stringify(host.sent)).not.toContain("SECRET");
  } finally { dispose(); }
});

test("cancellation releases the in-progress handle and late optimized media cannot trigger generation", async () => {
  const host = fixture(); Object.assign(host.mutable.host.capabilities, { "desktop-capture-optimize-v1": 1 });
  const pending = deferred<typeof host.capture>();
  host.mutable.desktop.capture.optimize = async input => { host.optimized.push(input); return pending.promise; };
  const dispose = installCompanion(host.api);
  try {
    await configure(host, { optimizeMedia: true }); host.emit(host.message()); await settle();
    expect(host.optimized).toHaveLength(1);
    host.emit({ channel: CHANNEL, clientId: "client-a", id: "cancel-a", type: "cancel", targetId: "request-a" }); await settle();
    expect(host.released).toEqual([{ assetId: host.capture.assetId, userId: "user-a" }]);
    pending.resolve(host.capture); await settle();
    expect(host.generations).toHaveLength(0);
    expect(host.sent.find(m => m.payload.type === "error")?.payload).toMatchObject({ type: "error", code: "CANCELLED" });
  } finally { dispose(); pending.resolve(host.capture); }
});
