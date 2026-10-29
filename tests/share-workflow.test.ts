import { describe, expect, test } from "bun:test";
import { AutomaticShareSpeech, prepareShareQuestion } from "../src/share-workflow";
import { deferred } from "./fixtures";

describe("one-action share workflow", () => {
  test("combines the host's complete transcript with typed context", async () => {
    expect(await prepareShareQuestion("  This game looks fun.  ", Promise.resolve("  What do you think?  "), new AbortController().signal))
      .toBe("This game looks fun.\n\nWhat do you think?");
  });
  test("cancelled recognition cannot yield a question for later generation", async () => {
    const controller = new AbortController(); const pending = deferred<string>();
    const question = prepareShareQuestion("", pending.promise, controller.signal);
    controller.abort(); pending.resolve("Late text");
    await expect(question).rejects.toMatchObject({ name: "AbortError" });
  });
  test("recognition failure and oversized questions stop the sequence", async () => {
    await expect(prepareShareQuestion("", Promise.reject(new Error("Failed")), new AbortController().signal)).rejects.toThrow("Failed");
    await expect(prepareShareQuestion("x".repeat(1199), Promise.resolve("Hello"), new AbortController().signal)).rejects.toThrow("1,200");
  });
  test("automatic speech is opt-in, request-bound, and consumed only once", () => {
    const speech = new AutomaticShareSpeech();
    speech.arm("text-only", null); expect(speech.take("text-only")).toBeNull();
    const voice = { connectionId: "tts-a", voice: "Mira", speed: 1.1 };
    speech.arm("share-a", voice); voice.connectionId = "different-provider";
    expect(speech.take("other-document-request")).toBeNull();
    expect(speech.take("share-a")).toEqual({ connectionId: "tts-a", voice: "Mira", speed: 1.1 });
    expect(speech.take("share-a")).toBeNull();
  });
  test("cancel, clear, Stop speech, and replacement suppress delayed speech", () => {
    const speech = new AutomaticShareSpeech(); const voice = { connectionId: "tts-a", voice: "Mira" };
    speech.arm("pending-voice-input", voice); speech.cancel(); expect(speech.take("pending-voice-input")).toBeNull();
    speech.arm("old-share", voice); speech.arm("new-share", voice);
    expect(speech.take("old-share")).toBeNull(); expect(speech.take("new-share")).toEqual(voice);
  });
});
