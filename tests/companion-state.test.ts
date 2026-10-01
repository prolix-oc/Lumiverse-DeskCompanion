import { describe, expect, test } from "bun:test";
import { installCompanion } from "../src/worker";
import { SETTINGS_PATH } from "../src/companion-state";
import { CHANNEL } from "../src/protocol";
import { DEFAULT_SETTINGS, parseSettingsPatch } from "../src/settings";
import { deferred, fixture, settle } from "./fixtures";

const READY_SETTINGS = { ...DEFAULT_SETTINGS, characterId: "character-a", connectionId: "model-a", deviceId: "desktop-a" };

function client(host: ReturnType<typeof fixture>, clientId: string, sessionId: string, userId = "user-a") {
  return (type: string, extra: Record<string, unknown> = {}, id = "message-a") => {
    host.emit({ channel: CHANNEL, clientId, id, type, ...extra }, userId, sessionId);
  };
}

describe("authoritative companion state", () => {
  test("bounds settings and refuses unexpected paths, identities, and switches", () => {
    for (const patch of [{ userId: "user-b" }, { path: "../secret" }, { autoSpeak: "true" }, { voiceSeconds: 16 },
      { durationSeconds: 31 }, { question: "x".repeat(1201) }, { speed: Number.NaN }, { deviceId: "../desktop" }, {}]) {
      expect(parseSettingsPatch(patch)).toBeNull();
    }
    expect(parseSettingsPatch({ autoSpeak: false, voiceInput: false, question: "" })).not.toBeNull();
  });

  test("synchronizes settings only to registered documents belonging to the authenticated user", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    const sidebar = client(host, "sidebar-a", "document-a"); const popout = client(host, "widget-a", "document-b");
    const other = client(host, "widget-b", "document-c", "user-b");
    try {
      sidebar("subscribe", { surface: "settings" }); popout("subscribe"); other("subscribe"); await settle();
      host.sent.length = 0;
      sidebar("configure", { patch: { ...READY_SETTINGS, autoSpeak: true, voiceInput: true } }, "save-a"); await settle();
      const states = host.sent.filter((entry) => entry.payload.type === "state");
      expect(states).toHaveLength(2);
      expect(states.every((entry) => entry.userId === "user-a")).toBe(true);
      expect(states.map((entry) => entry.options?.frontendSessionId).sort()).toEqual(["document-a", "document-b"]);
      expect(states.every((entry) => entry.payload.snapshot.settings.autoSpeak && entry.payload.snapshot.settings.voiceInput)).toBe(true);
      expect(host.stored.get(JSON.stringify(["user-a", SETTINGS_PATH]))).toEqual({ revision: 1, settings: { ...READY_SETTINGS, autoSpeak: true, voiceInput: true } });
      expect(host.stored.has(JSON.stringify(["user-b", SETTINGS_PATH]))).toBe(false);
      expect(host.requests).toHaveLength(0); expect(host.generations).toHaveLength(0);
    } finally { dispose(); }
  });

  test("reopening and restarting restores preferences but never persists or auto-replays a reply", async () => {
    const host = fixture(); let dispose = installCompanion(host.api);
    const sidebar = client(host, "sidebar-a", "document-a");
    try {
      sidebar("subscribe"); await settle(); sidebar("configure", { patch: READY_SETTINGS }); await settle();
      const epoch = host.sent.at(-1)?.payload.snapshot.epoch;
      host.emit(host.message()); await settle();
      expect(host.sent.some((entry) => entry.payload.type === "state" && entry.payload.snapshot.activity.text)).toBe(true);
      const stored = JSON.stringify([...host.stored.values()]); expect(stored).not.toContain("calendar"); expect(stored).not.toContain("private-asset");
      dispose(); dispose = installCompanion(host.api);
      client(host, "widget-new", "document-new")("subscribe"); await settle();
      const snapshot = host.sent.at(-1)?.payload.snapshot;
      expect(snapshot.settings).toEqual(READY_SETTINGS); expect(snapshot.epoch).not.toBe(epoch);
      expect(snapshot.activity.stage).toBe("idle"); expect(snapshot.activity.text).toBe("");
      expect(host.requests).toHaveLength(1);
    } finally { dispose(); }
  });

  test("claims a share before microphone input, prevents another widget from racing, and freezes settings", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    const sidebar = client(host, "sidebar-a", "document-a"); const popout = client(host, "widget-a", "document-b");
    try {
      sidebar("subscribe"); popout("subscribe"); await settle(); sidebar("configure", { patch: READY_SETTINGS }); await settle();
      popout("begin-share", { revision: 1 }, "share-a"); await settle();
      expect(host.sent.at(-1)?.payload.snapshot.activity.ownerClientId).toBe("widget-a");
      sidebar("begin-share", { revision: 1 }, "share-b"); await settle();
      expect(host.sent.at(-1)?.payload.code).toBe("BUSY");
      sidebar("configure", { patch: { kind: "video" } }); await settle(); expect(host.sent.at(-1)?.payload.code).toBe("BUSY");
      popout("input-stage", { targetId: "share-a", stage: "transcribing" }); await settle();
      expect(host.sent.at(-1)?.payload.snapshot.activity.stage).toBe("transcribing");
      sidebar("input-ended", { targetId: "share-a", message: "Spoofed cancellation" }); await settle();
      expect(host.sent.at(-1)?.payload.snapshot.activity.stage).toBe("transcribing");
      popout("input-ended", { targetId: "share-a", message: "Microphone declined" }); await settle();
      expect(host.sent.at(-1)?.payload.snapshot.activity.stage).toBe("idle");
      expect(host.requests).toHaveLength(0);
    } finally { dispose(); }
  });

  test("rejects stale settings before input and shares streamed replies without media handles", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    const sidebar = client(host, "sidebar-a", "document-a"); const popout = client(host, "widget-a", "document-b");
    try {
      sidebar("subscribe"); popout("subscribe"); await settle(); sidebar("configure", { patch: READY_SETTINGS }); await settle();
      popout("begin-share", { revision: 0 }, "share-stale"); await settle(); expect(host.sent.at(-1)?.payload.code).toBe("SETTINGS_CHANGED");
      popout("begin-share", { revision: 1 }, "share-a"); await settle();
      host.emit(host.message("share-a", { clientId: "widget-a" }), "user-a", "document-b"); await settle();
      const snapshots = host.sent.filter((entry) => entry.payload.type === "state");
      const sidebarReply = snapshots.filter((entry) => entry.options?.frontendSessionId === "document-a").at(-1)?.payload.snapshot;
      expect(sidebarReply.activity.text).toBe("You have a calendar open."); expect(sidebarReply.activity.stage).toBe("idle");
      expect(JSON.stringify(snapshots)).not.toContain("private-asset"); expect(JSON.stringify(snapshots)).not.toContain("metadata");
    } finally { dispose(); }
  });

  test("another synchronized widget can cancel, while other users and unsubscribed documents cannot", async () => {
    const host = fixture(); const approval = deferred<typeof host.capture>(); const dispose = installCompanion(host.api);
    host.mutable.desktop.capture.request = async (input) => { host.requests.push(input); return approval.promise; };
    const sidebar = client(host, "sidebar-a", "document-a"); const popout = client(host, "widget-a", "document-b");
    try {
      sidebar("subscribe"); popout("subscribe"); await settle(); sidebar("configure", { patch: READY_SETTINGS }); await settle();
      popout("begin-share", { revision: 1 }, "share-a"); await settle();
      host.emit(host.message("share-a", { clientId: "widget-a" }), "user-a", "document-b"); await settle();
      client(host, "outsider", "document-other")("cancel-shared", { targetId: "share-a" }); await settle();
      expect(host.sent.at(-1)?.payload.code).toBe("INVALID_REQUEST");
      sidebar("cancel-shared", { targetId: "share-a" }); await settle();
      expect(host.sent.some((entry) => entry.payload.type === "stop-local" && entry.options?.frontendSessionId === "document-b")).toBe(true);
      approval.resolve(host.capture); await settle();
      expect(host.generations).toHaveLength(0); expect(host.released).toHaveLength(1);
    } finally { approval.resolve(host.capture); dispose(); }
  });

  test("session closure releases an unfinished input share and removes only that document", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    const sidebar = client(host, "sidebar-a", "document-a"); const popout = client(host, "widget-a", "document-b");
    try {
      sidebar("subscribe"); popout("subscribe"); await settle(); popout("begin-share", { revision: 0 }, "share-a"); await settle();
      host.events.get("FRONTEND_SESSION_CLOSED")?.({ frontendSessionId: "document-b" }, "user-a"); await settle();
      expect(host.sent.at(-1)?.payload.snapshot.activity.stage).toBe("idle");
      host.sent.length = 0; sidebar("configure", { patch: { question: "Hello" } }); await settle();
      expect(host.sent.filter((entry) => entry.payload.type === "state")).toHaveLength(1);
      expect(host.sent.at(-1)?.options?.frontendSessionId).toBe("document-a");
    } finally { dispose(); }
  });

  test("storage failure does not replace synchronized settings or silently start capture", async () => {
    const host = fixture(); const dispose = installCompanion(host.api); const sidebar = client(host, "sidebar-a", "document-a");
    try {
      sidebar("subscribe"); await settle();
      host.mutable.userStorage.setJson = async () => { throw new Error("PRIVATE_STORAGE_FAILURE"); };
      sidebar("configure", { patch: { autoSpeak: true } }); await settle();
      expect(host.sent.at(-1)?.payload.code).toBe("SETTINGS_FAILED");
      expect(JSON.stringify(host.sent)).not.toContain("PRIVATE_STORAGE_FAILURE");
      sidebar("subscribe"); await settle(); expect(host.sent.at(-1)?.payload.snapshot.settings.autoSpeak).toBe(false);
      expect(host.requests).toHaveLength(0);
    } finally { dispose(); }
  });

  test("closing a document while storage is loading cannot resurrect its subscription", async () => {
    const host = fixture(); const loading = deferred<unknown>(); const dispose = installCompanion(host.api);
    host.mutable.userStorage.getJson = async () => loading.promise;
    try {
      client(host, "closing-widget", "closing-document")("subscribe");
      host.events.get("FRONTEND_SESSION_CLOSED")?.({ frontendSessionId: "closing-document" }, "user-a");
      loading.resolve(null); await settle();
      expect(host.sent).toHaveLength(0);
      client(host, "new-widget", "new-document")("subscribe"); await settle();
      expect(host.sent.filter((entry) => entry.payload.type === "state")).toHaveLength(1);
      expect(host.sent.at(-1)?.options?.frontendSessionId).toBe("new-document");
    } finally { loading.resolve(null); dispose(); }
  });

  test("partial or corrupt persisted preferences never enable voice input or automatic speech", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    host.stored.set(JSON.stringify(["user-a", SETTINGS_PATH]), { revision: 5, settings: { autoSpeak: true, voiceInput: true } });
    try {
      client(host, "widget-a", "document-a")("subscribe"); await settle();
      expect(host.sent.at(-1)?.payload.snapshot.settings).toEqual(DEFAULT_SETTINGS);
      expect(host.requests).toHaveLength(0);
    } finally { dispose(); }
  });
});
