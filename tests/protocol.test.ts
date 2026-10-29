import { describe, expect, test } from "bun:test";
import { CHANNEL, characterVoice, createMessageId, identifier, mediaSupport, parseClientMessage, safeLabel } from "../src/protocol";

describe("request and character boundaries", () => {
  test("generates bounded opaque message IDs without a secure-context-only UUID API", () => {
    const first = createMessageId(); const second = createMessageId();
    expect(first).toMatch(/^[0-9a-f]{32}$/); expect(identifier(first)).toBe(true); expect(second).not.toBe(first);
  });
  const input = { channel: CHANNEL, id: "request-a", clientId: "client-a", type: "observe", characterId: "character-a",
    connectionId: "model-a", deviceId: "desktop-a", question: "What is visible?", kind: "image", durationSeconds: 3 };
  test("rejects malformed, unbounded, and replay requests", () => {
    for (const change of [{ question: undefined }, { question: null }, { question: 42 }, { question: "x".repeat(1201) }, { durationSeconds: 0 }, { durationSeconds: 121 },
      { durationSeconds: 1.5 }, { kind: "replay" }, { clientId: {} }, { connectionId: "../secret" }, { channel: "other" }]) {
      expect(parseClientMessage({ ...input, ...change })).toBeNull();
    }
    expect(parseClientMessage({ ...input, question: "  Hello  " })?.type).toBe("observe");
  });
  test("accepts a blank optional question while retaining input bounds", () => {
    for (const question of ["", " \n\t "]) {
      const message = parseClientMessage({ ...input, question });
      expect(message?.type).toBe("observe");
      if (message?.type === "observe") expect(message.question).toBe("");
    }
    expect(parseClientMessage({ ...input, question: " ".repeat(1201) })).toBeNull();
  });
  test("does not accept negative or excessive character pages", () => {
    for (const page of [-1, 10001, "0", 0.5]) expect(parseClientMessage({ ...input, type: "catalog", page })).toBeNull();
  });
  test("bounds character search and pagination requests", () => {
    const base = { channel: CHANNEL, id: "request", clientId: "client", type: "characters", offset: 50, search: "  Mira  " };
    expect(parseClientMessage(base)).toMatchObject({ offset: 50, search: "Mira" });
    for (const offset of [-1, 0.5, 500001, Infinity]) expect(parseClientMessage({ ...base, offset })).toBeNull();
    expect(parseClientMessage({ ...base, search: "x".repeat(201) })).toBeNull();
  });
  test("Vertex partners do not inherit Gemini video support", () => {
    expect(mediaSupport("google_vertex", "publishers/google/models/gemini-2.5-flash").video).toBe(true);
    expect(mediaSupport("google_vertex", "claude-sonnet-4-6").video).toBe(false);
    expect(mediaSupport("openrouter", "google/gemini-2.5-flash").video).toBe(false);
  });
  test("Z.ai vision support follows the documented Flash family, not every GLM model or route", () => {
    for (const model of ["glm-5.3-flash", "glm-5.3-flashx", "glm-5.3-flashx-legal", "GLM-5.3-FLASH"]) {
      expect(mediaSupport("zai", model)).toEqual({ image: true, video: true });
    }
    for (const model of ["glm-5.3", "glm-5.2", "glm-4.7", "glm-5.3-flash-fictional"]) {
      expect(mediaSupport("zai", model)).toEqual({ image: false, video: false });
    }
    expect(mediaSupport("openai", "glm-5.3-flash").video).toBe(false);
  });
  test("extracts only valid character voice settings", () => {
    expect(characterVoice({ ttsVoice: { connectionId: "voice-a", voice: "warm", parameters: { speed: 1.2, secret: "no" } } }))
      .toEqual({ connectionId: "voice-a", voice: "warm", speed: 1.2 });
    expect(characterVoice({ ttsVoice: { connectionId: "../secret", voice: "warm" } })).toBeNull();
    expect(characterVoice({ ttsVoice: { connectionId: "voice-a", voice: "warm", parameters: { speed: NaN } } }))
      .toEqual({ connectionId: "voice-a", voice: "warm" });
  });
  test("native purpose labels cannot contain control characters or bidi overrides", () => {
    expect(safeLabel("Mi\nra\u202e".repeat(100), 60)).toHaveLength(60);
    expect(safeLabel("Mi\nra\u202e")).toBe("Mi ra ");
  });
});
