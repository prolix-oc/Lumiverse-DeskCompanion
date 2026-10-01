import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("declares distinct main and lightweight system widget entries", () => {
  const manifest = JSON.parse(source("spindle.json"));
  expect(manifest.entry_frontend_widget).toBe("dist/widget.js");
  expect(manifest.permissions).toEqual(["ui_panels", "characters", "generation", "screen_capture", "screen_recording"]);
  expect(source("src/widget.ts")).toContain("export function setupWidget");
  expect(source("src/frontend.ts")).toContain("export function setup");
  expect(source("src/companion-widget.ts")).toContain("ctx.ui.createFloatWidget");
  expect(source("src/companion-widget.ts")).toContain("spindle:desktop-widget-returned");
  expect(source("package.json")).toContain('"lumiverse-spindle-types": "0.6.37"');
  expect(JSON.parse(source("package.json")).version).toBe(manifest.version);
});

test("frontend gates on session origin while the worker gates on server routing", () => {
  for (const entry of ["src/frontend.ts", "src/companion-widget.ts"]) {
    expect(source(entry)).toContain('"frontend-session-origin-v1"');
    expect(source(entry)).not.toContain('"frontend-session-routing-v1"');
  }
  expect(source("src/worker.ts")).toContain('"frontend-session-routing-v1"');
});

test("frontend has no capture API, capture IPC, media handles, history writes, or autonomous capture loop", () => {
  const frontend = ["src/frontend.ts", "src/widget.ts", "src/companion-view.ts", "src/companion-widget.ts", "src/speech.ts", "src/speech-input.ts", "src/share-workflow.ts"].map(source).join("\n");
  for (const forbidden of ["desktop.capture.", "getDisplayMedia", "@tauri-apps", "window.open(", "asset_id", "localStorage", "sessionStorage", "setInterval("]) expect(frontend).not.toContain(forbidden);
  expect(source("src/companion-view.ts")).toContain("reply.textContent = message.text");
  const backend = source("src/worker.ts");
  expect(backend).not.toContain("chat.appendMessage"); expect(backend).not.toContain("generate.quiet");
  expect(backend).not.toContain("console.log"); expect(backend).toContain("api.desktop.capture.release");
});

test("observation does not require a question to request a default companion reaction", () => {
  const view = source("src/companion-view.ts");
  expect(view).toContain("Optional question or direction");
  expect(view).toContain("Leave blank for a brief, in-character reaction");
  expect(view).not.toContain("!question.value.trim()");
  expect(view).toContain("question.value.length > MAX_QUESTION");
});
