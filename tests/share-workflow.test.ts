import { describe, expect, test } from "bun:test";
import { AutomaticShareSpeech, prepareShareQuestion } from "../src/share-workflow";
import { deferred } from "./fixtures";

describe("one-action share workflow", () => {
  const recording = { audio: new Blob(["voice"], { type: "audio/webm" }), fileName: "question.webm" };
  test("records then transcribes once and combines typed and spoken context", async () => {
    const events: string[] = [];
    const signal = new AbortController().signal;
    const question = await prepareShareQuestion("  This game looks fun.  ", { connectionId: "stt-a", seconds: 5 }, signal,
      (stage) => events.push(stage), {
        async record(seconds, receivedSignal) { expect(seconds).toBe(5); expect(receivedSignal).toBe(signal); events.push("record"); return recording; },
        async transcribe(audio, connectionId, receivedSignal) {
          expect(audio).toBe(recording); expect(connectionId).toBe("stt-a"); expect(receivedSignal).toBe(signal); events.push("transcribe"); return "  What do you think?  ";
        },
      });
    expect(question).toBe("This game looks fun.\n\nWhat do you think?");
    expect(events).toEqual(["listening", "record", "transcribing", "transcribe"]);
  });
  test("cancellation after recording never uploads microphone audio", async () => {
    const controller = new AbortController(); let uploads = 0;
    await expect(prepareShareQuestion("", { connectionId: "stt-a", seconds: 5 }, controller.signal, () => {}, {
      async record() { controller.abort(); return recording; },
      async transcribe() { uploads += 1; return "Hello"; },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(uploads).toBe(0);
  });
  test("cancelled transcription cannot yield a question for later generation", async () => {
    const controller = new AbortController(); const pending = deferred<string>();
    const question = prepareShareQuestion("", { connectionId: "stt-a", seconds: 5 }, controller.signal, () => {}, {
      async record() { return recording; }, async transcribe() { return pending.promise; },
    });
    controller.abort(); pending.resolve("Late text");
    await expect(question).rejects.toMatchObject({ name: "AbortError" });
  });
  test("transcription failure or oversized combined input stops the sequence", async () => {
    await expect(prepareShareQuestion("", { connectionId: "stt-a", seconds: 5 }, new AbortController().signal, () => {}, {
      async record() { return recording; }, async transcribe() { throw new Error("Failed"); },
    })).rejects.toThrow("Failed");
    await expect(prepareShareQuestion("x".repeat(1199), { connectionId: "stt-a", seconds: 5 }, new AbortController().signal, () => {}, {
      async record() { return recording; }, async transcribe() { return "Hello"; },
    })).rejects.toThrow("1,200");
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
