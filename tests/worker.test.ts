import { describe, expect, test } from "bun:test";
import { CHANNEL, MAX_REPLY } from "../src/protocol";
import { installCompanion } from "../src/worker";
import { DEFAULT_REACTION_PROMPT } from "../src/prompt";
import { deferred, fixture, settle } from "./fixtures";

describe("Desk Companion worker", () => {
  test("a blank question generates a default character reaction after approved capture", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    try {
      host.emit(host.message("request-a", { question: " \n " })); await settle();
      expect(host.requests).toHaveLength(1); expect(host.generations).toHaveLength(1);
      expect(host.requests[0].purpose).toContain("react naturally as Mira");
      expect(host.generations[0].messages[1].content).toEqual([
        { type: "text", text: DEFAULT_REACTION_PROMPT }, { type: "desktop_capture", asset_id: "private-asset-a" },
      ]);
      expect(host.released).toHaveLength(1);
    } finally { dispose(); }
  });
  test("assembles a character-aware raw request with only an opaque capture reference", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    try {
      host.emit(host.message()); await settle();
      expect(host.requests).toHaveLength(1); expect(host.generations).toHaveLength(1);
      expect(host.requests[0].userId).toBe("user-a");
      const generation = host.generations[0];
      expect(generation.type).toBe("raw"); expect(generation.connection_id).toBe("model-a"); expect(generation.userId).toBe("user-a");
      expect(generation.tools).toEqual([]); expect(generation.reasoning).toEqual({ source: "off" });
      expect(generation.messages[0].content).toContain("Mira");
      expect(generation.messages[0].content).toContain("Warm and observant");
      expect(generation.messages[1].content).toEqual([{ type: "text", text: "What do you notice?" }, { type: "desktop_capture", asset_id: "private-asset-a" }]);
      expect(host.released).toEqual([{ assetId: "private-asset-a", userId: "user-a" }]);
      expect(host.sent.every((entry) => entry.userId === "user-a" && entry.options?.frontendSessionId === "session-a")).toBe(true);
      const frontend = JSON.stringify(host.sent);
      expect(frontend).not.toContain("private-asset-a"); expect(frontend).not.toContain("private reasoning");
      expect(frontend).not.toContain("must not reach frontend");
      expect(host.sent.find((entry) => entry.payload.type === "complete")?.payload.voice).toEqual({ connectionId: "voice-a", voice: "warm", speed: 1.1 });
    } finally { dispose(); }
  });

  test("uses only trusted host user and document identity, never a payload-supplied identity", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    try {
      host.emit(host.message("request-a", { userId: "victim", frontendSessionId: "victim-document" })); await settle();
      expect(host.gets.every((entry) => entry.userId === "user-a")).toBe(true);
      expect(host.sent.every((entry) => entry.options?.frontendSessionId === "session-a")).toBe(true);
    } finally { dispose(); }
  });

  test("does not capture when document routing or capture support is missing", async () => {
    const host = fixture(); host.mutable.host.capabilities["desktop-capture-worker-v1"] = 0;
    const dispose = installCompanion(host.api);
    try {
      host.emit(host.message()); await settle();
      expect(host.requests).toHaveLength(0); expect(host.sent[0].payload.code).toBe("HOST_UNSUPPORTED");
      host.mutable.host.capabilities["desktop-capture-worker-v1"] = 1;
      host.emit(host.message(), "user-a", ""); await settle();
      expect(host.requests).toHaveLength(0);
      expect(host.sent).toHaveLength(1);
      host.mutable.host.capabilities["frontend-session-routing-v1"] = 0;
      host.emit(host.message()); await settle();
      expect(host.requests).toHaveLength(0); expect(host.sent.at(-1)?.payload.code).toBe("HOST_UNSUPPORTED");
    } finally { dispose(); }
  });

  test("preserves opaque trusted host identities instead of applying payload identifier rules", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    try {
      host.emit(host.message(), "user:owned", "document:opaque"); await settle();
      expect(host.generations).toHaveLength(1);
      expect(host.gets.every((entry) => entry.userId === "user:owned")).toBe(true);
      expect(host.sent.every((entry) => entry.userId === "user:owned" && entry.options?.frontendSessionId === "document:opaque")).toBe(true);
    } finally { dispose(); }
  });

  test("native capture decline never dispatches a model request or raw error", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    host.mutable.desktop.capture.request = async () => { throw new Error("Capture declined: PRIVATE_SOURCE"); };
    try {
      host.emit(host.message()); await settle();
      expect(host.generations).toHaveLength(0); expect(host.released).toHaveLength(0);
      expect(host.sent.at(-1)?.payload.code).toBe("CAPTURE_FAILED");
      expect(JSON.stringify(host.sent)).not.toContain("PRIVATE_SOURCE");
    } finally { dispose(); }
  });

  test("does not start a prompt for unsupported video models or devices", async () => {
    const host = fixture(); host.connection.provider = "openai";
    const dispose = installCompanion(host.api);
    try {
      host.emit(host.message("request-a", { kind: "video" })); await settle();
      expect(host.requests).toHaveLength(0); expect(host.generations).toHaveLength(0);
      expect(host.sent.at(-1)?.payload.code).toBe("MEDIA_UNSUPPORTED");
    } finally { dispose(); }
  });

  test("records bounded video without arming a replay buffer", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    try {
      host.emit(host.message("request-a", { kind: "video", durationSeconds: 5 })); await settle();
      expect(host.requests[0].mode).toBe("record"); expect(host.requests[0].durationSeconds).toBe(5);
      expect(host.generations).toHaveLength(1); expect(host.released).toHaveLength(1);
    } finally { dispose(); }
  });

  test("a cancelled pending capture is released when it resolves and is never sent to a model", async () => {
    const host = fixture(); const pending = deferred<typeof host.capture>();
    host.mutable.desktop.capture.request = async (input) => { host.requests.push(input); return pending.promise; };
    const dispose = installCompanion(host.api);
    try {
      host.emit(host.message()); await settle();
      host.emit({ channel: CHANNEL, type: "cancel", id: "cancel-a", clientId: "client-a", targetId: "request-a" });
      pending.resolve(host.capture); await settle();
      expect(host.generations).toHaveLength(0); expect(host.released).toHaveLength(1);
      expect(host.sent.at(-1)?.payload.code).toBe("CANCELLED");
    } finally { dispose(); }
  });

  test("another document or client cannot cancel the observation", async () => {
    const host = fixture(); const pending = deferred<typeof host.capture>();
    host.mutable.desktop.capture.request = async () => pending.promise;
    const dispose = installCompanion(host.api);
    try {
      host.emit(host.message()); await settle();
      host.emit({ channel: CHANNEL, type: "cancel", id: "cancel-a", clientId: "client-a", targetId: "request-a" }, "user-a", "session-b");
      host.emit({ channel: CHANNEL, type: "cancel", id: "cancel-b", clientId: "client-b", targetId: "request-a" });
      pending.resolve(host.capture); await settle();
      expect(host.generations).toHaveLength(1); expect(host.sent.at(-1)?.payload.type).toBe("complete");
    } finally { dispose(); }
  });

  test("document disconnect and permission revocation stop dispatch", async () => {
    for (const cause of ["disconnect", "permission"]) {
      const host = fixture(); const pending = deferred<typeof host.capture>();
      host.mutable.desktop.capture.request = async () => pending.promise;
      const dispose = installCompanion(host.api);
      try {
        host.emit(host.message()); await settle();
        if (cause === "disconnect") host.events.get("FRONTEND_SESSION_CLOSED")?.({ frontendSessionId: "session-a" }, "user-a");
        else host.events.get("PERMISSION_CHANGED")?.({ granted: false, permission: "screen_capture" });
        pending.resolve(host.capture); await settle();
        expect(host.generations).toHaveLength(0); expect(host.released).toHaveLength(1);
      } finally { dispose(); }
    }
  });

  test("aborts the actual generation signal and clears a consumed capture", async () => {
    const host = fixture(); const entered = deferred<void>();
    host.mutable.generate.rawStream = async function* (input) {
      host.generations.push(input); entered.resolve();
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("Aborted", "AbortError");
    };
    const dispose = installCompanion(host.api);
    try {
      host.emit(host.message()); await entered.promise;
      host.emit({ channel: CHANNEL, type: "cancel", id: "cancel-a", clientId: "client-a", targetId: "request-a" }); await settle();
      expect(host.generations[0].signal.aborted).toBe(true); expect(host.released).toHaveLength(1);
      expect(host.sent.at(-1)?.payload.code).toBe("CANCELLED");
    } finally { dispose(); }
  });

  test("limits concurrent observations and prompt frequency", async () => {
    const host = fixture(); const pending = deferred<typeof host.capture>();
    host.mutable.desktop.capture.request = async () => pending.promise;
    const dispose = installCompanion(host.api, { now: () => host.now });
    try {
      host.emit(host.message()); await settle();
      host.emit(host.message("request-b")); await settle(); expect(host.sent.at(-1)?.payload.code).toBe("BUSY");
      pending.resolve(host.capture); await settle();
      host.emit(host.message("request-c")); await settle(); expect(host.sent.at(-1)?.payload.code).toBe("COOLDOWN");
    } finally { dispose(); }
  });

  test("times out and releases an eventual capture without generation", async () => {
    const host = fixture(); const pending = deferred<typeof host.capture>();
    host.mutable.desktop.capture.request = async () => pending.promise;
    const dispose = installCompanion(host.api, { timeoutMs: 10 });
    try {
      host.emit(host.message()); await settle(); pending.resolve(host.capture); await settle();
      expect(host.generations).toHaveLength(0); expect(host.released).toHaveLength(1); expect(host.sent.at(-1)?.payload.code).toBe("TIMED_OUT");
    } finally { dispose(); }
  });

  test("output limits, provider errors, and invalid receipts all release captures", async () => {
    for (const cause of ["large", "provider", "receipt"]) {
      const host = fixture();
      if (cause === "receipt") host.capture.connectionId = "other-connection";
      host.mutable.generate.rawStream = async function* (input) {
        host.generations.push(input);
        if (cause === "provider") throw new Error("SECRET and captured pixels must not be echoed");
        yield { type: "token", token: "x".repeat(MAX_REPLY + 1) };
      };
      const dispose = installCompanion(host.api);
      try {
        host.emit(host.message()); await settle();
        expect(host.released).toHaveLength(1); expect(host.sent.at(-1)?.payload.type).toBe("error");
        expect(JSON.stringify(host.sent)).not.toContain("SECRET");
        expect(host.sent.some((entry) => entry.payload.type === "complete")).toBe(false);
      } finally { dispose(); }
    }
  });

  test("catalog strips character internals and connection metadata", async () => {
    const host = fixture(); const dispose = installCompanion(host.api);
    try {
      host.emit({ channel: CHANNEL, type: "catalog", id: "catalog-a", clientId: "client-a", page: 0 }); await settle();
      const catalog = host.sent[0].payload.catalog;
      expect(catalog.characters[0].name).toBe("Mira"); expect(catalog.connections[0].provider).toBe("google");
      expect(JSON.stringify(catalog)).not.toContain("must not reach frontend");
      expect(JSON.stringify(catalog)).not.toContain("description");
      expect(JSON.stringify(catalog)).not.toContain("api_key");
    } finally { dispose(); }
  });

  test("disposal cancels in-flight work without broadcasting a late result", async () => {
    const host = fixture(); const pending = deferred<typeof host.capture>();
    host.mutable.desktop.capture.request = async () => pending.promise;
    const dispose = installCompanion(host.api);
    host.emit(host.message()); await settle(); dispose(); const count = host.sent.length;
    pending.resolve(host.capture); await settle();
    expect(host.generations).toHaveLength(0); expect(host.released).toHaveLength(1); expect(host.sent).toHaveLength(count);
  });
});
