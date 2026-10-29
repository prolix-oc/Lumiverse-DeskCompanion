import { describe, expect, test } from "bun:test";
import { createHistory, historyPath } from "../src/history";
import { DEFAULT_SETTINGS, parseSettings, parseSettingsPatch } from "../src/settings";
import { installCompanion } from "../src/worker";
import { CHARACTER, deferred, fixture, settle } from "./fixtures";
import { CHANNEL } from "../src/protocol";

describe("rolling companion conversation", () => {
  test("migrates Gemini media detail to inherit and accepts the new recording bounds", () => {
    const { mediaResolution: _, ...old } = DEFAULT_SETTINGS;
    expect(parseSettings(old)?.mediaResolution).toBe("inherit");
    for (const mediaResolution of ["inherit", "unspecified", "low", "medium", "high"]) {
      expect(parseSettingsPatch({ mediaResolution })).toEqual({ mediaResolution });
    }
    for (const mediaResolution of ["ultra_high", null, 42, {}]) expect(parseSettingsPatch({ mediaResolution })).toBeNull();
    expect(parseSettingsPatch({ durationSeconds: 120 })).toEqual({ durationSeconds: 120 });
    expect(parseSettingsPatch({ durationSeconds: 121 })).toBeNull();
  });

  test("defaults and migrates to five complete exchanges with no fixed user-configurable ceiling", () => {
    const { historyTurns: _, ...old } = DEFAULT_SETTINGS;
    expect(parseSettings(old)?.historyTurns).toBe(5);
    for (const historyTurns of [0, 5, 100, Number.MAX_SAFE_INTEGER]) expect(parseSettingsPatch({ historyTurns })).toEqual({ historyTurns });
    for (const historyTurns of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "5"]) expect(parseSettingsPatch({ historyTurns })).toBeNull();
  });

  test("persists only the newest pairs and isolates characters and authenticated accounts", async () => {
    const host = fixture(); let history = createHistory(host.api);
    for (let i = 0; i < 7; i++) await history.append("alice", "character-a", 5, { user: `Question ${i}`, assistant: `Reply ${i}` });
    history = createHistory(host.api);
    expect(await history.read("alice", "character-a", 5)).toEqual(Array.from({ length: 5 }, (_, i) => ({ user: `Question ${i + 2}`, assistant: `Reply ${i + 2}` })));
    expect(await history.read("bob", "character-a", 5)).toEqual([]);
    expect(await history.read("alice", "character-b", 5)).toEqual([]);
    await history.trim("alice", "character-a", 2);
    expect(await history.read("alice", "character-a", 100)).toHaveLength(2);
    await history.clear("alice", "character-a");
    expect(await history.read("alice", "character-a", 5)).toEqual([]);
    await history.append("alice", "character-a", 0, { user: "unused", assistant: "unused" });
    expect(await history.read("alice", "character-a", 5)).toEqual([]);
    expect(() => historyPath("../secret")).toThrow();
  });

  test("serializes simultaneous writes and rejects malformed persisted history", async () => {
    const host = fixture(); const history = createHistory(host.api);
    await Promise.all(Array.from({ length: 4 }, (_, i) => history.append("alice", "character-a", 5, { user: `Q${i}`, assistant: `A${i}` })));
    expect(await history.read("alice", "character-a", 5)).toHaveLength(4);
    host.stored.set(JSON.stringify(["alice", historyPath("character-a")]), [{ user: "Q", assistant: { assetId: "secret" } }]);
    await expect(history.read("alice", "character-a", 5)).rejects.toThrow();
    await history.clear("alice", "character-a");
    expect(await history.read("alice", "character-a", 5)).toEqual([]);
  });

  test("cancellation during a history write restores the previous pairs and a following Clear wins", async () => {
    const host = fixture(); const history = createHistory(host.api);
    await history.append("alice", "character-a", 5, { user: "Earlier question", assistant: "Earlier reply" });
    const original = host.mutable.userStorage.setJson;
    for (const clear of [false, true]) {
      const write = deferred<void>(); const entered = deferred<void>(); let first = true;
      host.mutable.userStorage.setJson = async (...args) => {
        if (first) { first = false; entered.resolve(); await write.promise; }
        await original(...args);
      };
      const controller = new AbortController();
      const append = history.append("alice", "character-a", 5, { user: "Cancelled question", assistant: "Cancelled reply" }, controller.signal);
      await entered.promise; controller.abort();
      const clearing = clear ? history.clear("alice", "character-a") : Promise.resolve();
      write.resolve(); await append; await clearing;
      expect(await history.read("alice", "character-a", 5)).toEqual(clear ? [] : [{ user: "Earlier question", assistant: "Earlier reply" }]);
    }
  });

  test("later requests receive past text after restart, with only the current capture attached", async () => {
    const host = fixture(); let clock = host.now;
    let dispose = installCompanion(host.api, { now: () => clock });
    try {
      host.emit(host.message("first", { question: "Typed direction. Spoken question: what changed?" })); await settle();
      expect(host.generations).toHaveLength(1);
      dispose(); dispose = installCompanion(host.api, { now: () => clock }); clock += 10001;
      host.emit(host.message("second", { question: "Tell me more." })); await settle();
      const messages = host.generations[1].messages;
      expect(messages.slice(-3, -1)).toEqual([
        { role: "user", content: "Typed direction. Spoken question: what changed?" },
        { role: "assistant", content: "You have a calendar open." },
      ]);
      expect(messages.at(-1).content[0].text).toBe("Tell me more.");
      expect(JSON.stringify(messages).match(/private-asset-a/g)).toHaveLength(1);
      expect(JSON.stringify([...host.stored.values()])).not.toContain("private-asset-a");
      expect(String(messages[0].content)).toContain(CHARACTER.personality);
      host.emit({ channel: CHANNEL, clientId: "client-a", id: "subscribe", type: "subscribe" }); await settle();
      host.emit({ channel: CHANNEL, clientId: "client-a", id: "settings", type: "configure", patch: { characterId: CHARACTER.id } }); await settle();
      host.emit({ channel: CHANNEL, clientId: "client-a", id: "clear", type: "clear-state" }); await settle();
      expect(host.stored.get(JSON.stringify(["user-a", historyPath(CHARACTER.id)]))).toEqual([]);
      clock += 10001; host.emit(host.message("third")); await settle();
      expect(host.generations[2].messages.slice(-3, -1)).not.toContainEqual({ role: "user", content: "Tell me more." });
    } finally { dispose(); }
  });

  test("failed generations are excluded and a storage failure preserves a successful reply", async () => {
    const host = fixture(); let clock = host.now;
    const dispose = installCompanion(host.api, { now: () => clock });
    const generate = host.mutable.generate.rawStream;
    try {
      host.mutable.generate.rawStream = async function* () { yield { type: "token", token: "Partial" }; throw new Error("provider failed"); };
      host.emit(host.message("failed")); await settle();
      expect([...host.stored.values()]).toEqual([]);
      host.mutable.generate.rawStream = generate; clock += 10001;
      host.mutable.userStorage.setJson = async () => { throw new Error("quota"); };
      host.emit(host.message("successful")); await settle();
      expect(host.sent.at(-1)?.payload).toMatchObject({ type: "complete", text: "You have a calendar open.", historyWarning: expect.stringContaining("could not be saved") });
      expect(host.released).toHaveLength(2);
    } finally { dispose(); }
  });
});
