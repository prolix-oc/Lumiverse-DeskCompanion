import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { SpindleFrontendContext } from "lumiverse-spindle-types";
import { setup } from "../src/frontend";
import { setupWidget } from "../src/widget";
import { settle } from "./fixtures";

function frontend(input: { capabilities?: Record<string, number>; sessionId?: string | null; granted?: string[] } = {}) {
  const dom = new JSDOM("<main></main>", { url: "https://lumiverse.test/" });
  const originals = new Map(["window", "document", "Option", "fetch"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const root = dom.window.document.querySelector("main")!;
  const callbacks = new Map<string, Set<(payload: unknown) => void>>();
  const backendHandlers = new Set<(payload: unknown) => void>();
  const widgetOptions: unknown[] = [];
  const widgetRoots: HTMLElement[] = [];
  let drawerActivations = 0;
  let granted = input.granted ?? ["ui_panels", "characters", "generation", "screen_capture", "screen_recording"];
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  const replacements = { window: dom.window, document: dom.window.document, Option: dom.window.Option,
    fetch: async () => Response.json({ data: [] }) };
  for (const [name, value] of Object.entries(replacements)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const context = {
    manifest: { identifier: "desk_companion" },
    host: { descriptorVersion: 1, lumiverseVersion: "1.2.4", extensionInstallationId: "installed-extension-a",
      capabilities: input.capabilities ?? { "frontend-session-origin-v1": 1 } },
    frontendSessionId: input.sessionId === null ? undefined : input.sessionId ?? "document-a",
    dom: { addStyle(css: string) { const style = dom.window.document.createElement("style"); style.textContent = css; dom.window.document.head.append(style); return () => style.remove(); } },
    ui: {
      registerDrawerTab() { const drawer = dom.window.document.createElement("section"); root.append(drawer); return { root: drawer, activate: () => { drawerActivations += 1; }, destroy: () => drawer.remove() }; },
      createFloatWidget(options: unknown) {
        if (!granted.includes("ui_panels")) throw new Error("UI permission denied");
        widgetOptions.push(options);
        const panel = dom.window.document.createElement("div"); root.append(panel); widgetRoots.push(panel);
        return { root: panel, widgetId: `widget-${widgetRoots.length}`, destroy: () => panel.remove() };
      },
    },
    permissions: { async getGranted() { return [...granted]; }, async request() { return [...granted]; } },
    getActiveChat: () => ({ characterId: null, chatId: null }), sendToBackend() {},
    onBackendMessage(handler: (payload: unknown) => void) { backendHandlers.add(handler); return () => backendHandlers.delete(handler); },
    events: { on(name: string, handler: (payload: unknown) => void) {
      const listeners = callbacks.get(name) ?? new Set(); listeners.add(handler); callbacks.set(name, listeners);
      return () => listeners.delete(handler);
    } },
  } as unknown as SpindleFrontendContext;
  return { context, root, dom, widgetRoots, widgetOptions, backendHandlers,
    drawerActivations: () => drawerActivations,
    setGranted: (permissions: string[]) => { granted = permissions; },
    permission: (extensionId = "installed-extension-a", permission = "ui_panels", allowed = true) => {
      for (const callback of [...(callbacks.get("SPINDLE_PERMISSION_CHANGED") ?? [])]) callback({ extensionId, permission, granted: allowed, allGranted: [...granted] });
    },
    async close() {
      await settle(); dom.window.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

describe("real frontend session startup contract", () => {
  test("widget startup does not require crypto.randomUUID in a development webview", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: random } });
    const host = frontend(); const dispose = setup(host.context);
    try {
      await settle(); expect(host.root.querySelector(".dc-shell")).not.toBeNull();
    } finally {
      dispose(); await host.close();
      if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else Reflect.deleteProperty(globalThis, "crypto");
    }
  });
  test("spawns the main widget with the frontend origin capability, without server routing in the frontend descriptor", async () => {
    const host = frontend(); const dispose = setup(host.context);
    try {
      await settle();
      expect(host.widgetRoots).toHaveLength(1); expect(host.root.querySelector(".dc-shell")).not.toBeNull();
      expect(host.context.host.capabilities["frontend-session-routing-v1"]).toBeUndefined();
      expect(host.root.querySelector('[data-role="status"]')?.textContent).toContain("widget is registered");
    } finally { dispose(); dispose(); await host.close(); }
  });
  test("native pop-out startup accepts the same origin capability and target dimensions", async () => {
    const host = frontend(); const dispose = setupWidget(host.context, { index: 0, width: 420, height: 720, chromeless: true });
    try {
      expect(host.widgetRoots).toHaveLength(1); expect(host.widgetOptions[0]).toMatchObject({ width: 420, height: 720, chromeless: true });
      expect(host.root.querySelector(".dc-shell")).not.toBeNull();
    } finally { dispose(); await host.close(); }
  });
  test("server routing alone or a missing frontend identity cannot bypass the frontend gate", async () => {
    for (const settings of [{ capabilities: { "frontend-session-routing-v1": 1 } }, { sessionId: null }]) {
      const host = frontend(settings); const dispose = setup(host.context);
      try {
        await settle(); expect(host.widgetRoots).toHaveLength(0);
        expect(host.root.textContent).toContain("document-scoped frontend session identity");
        expect(() => setupWidget(host.context, { index: 0, width: 420, height: 720, chromeless: false })).toThrow("session identity");
      } finally { dispose(); await host.close(); }
    }
  });
  test("grants from Extensions settings start the widget automatically and installation-scoped revocation tears it down", async () => {
    const host = frontend({ granted: [] }); const dispose = setup(host.context);
    try {
      await settle(); expect(host.widgetRoots).toHaveLength(0);
      host.setGranted(["ui_panels", "characters", "generation", "screen_capture"]);
      host.permission("other-installation"); await settle(); expect(host.widgetRoots).toHaveLength(0);
      host.permission(); host.permission(); await settle(); expect(host.widgetRoots).toHaveLength(1);
      expect(host.root.querySelectorAll(".dc-widget")).toHaveLength(1);
      expect(host.root.querySelectorAll(".dc-settings")).toHaveLength(1);
      host.setGranted([]); host.permission("installed-extension-a", "ui_panels", false); await settle();
      expect(host.root.querySelector(".dc-shell")).toBeNull(); expect(host.backendHandlers.size).toBe(0);
    } finally { dispose(); await host.close(); }
  });
  test("native return handling uses installation identity, not the manifest's public identifier", async () => {
    const host = frontend(); const dispose = setup(host.context);
    try {
      await settle();
      const panel = host.root.querySelector<HTMLElement>(".dc-widget")!; panel.remove();
      host.dom.window.dispatchEvent(new host.dom.window.CustomEvent("spindle:desktop-widget-returned", { detail: { extensionId: "desk_companion", widgetId: "widget-1" } }));
      expect(panel.isConnected).toBe(false);
      host.dom.window.dispatchEvent(new host.dom.window.CustomEvent("spindle:desktop-widget-returned", { detail: { extensionId: "installed-extension-a", widgetId: "widget-1" } }));
      expect(panel.parentElement === host.widgetRoots[0]).toBe(true);
    } finally { dispose(); await host.close(); }
  });
  test("configuration stays in the sidebar while the bounded compact widget scrolls", async () => {
    const host = frontend(); const dispose = setup(host.context);
    try {
      await settle();
      const widget = host.root.querySelector<HTMLElement>(".dc-widget")!;
      const settings = host.root.querySelector<HTMLElement>(".dc-settings")!;
      expect(widget.querySelectorAll("select,input,textarea")).toHaveLength(0);
      expect(settings.querySelectorAll("select,input,textarea").length).toBeGreaterThan(10);
      expect(settings.querySelector('[data-role="observe"]')).toBeNull();
      expect(host.widgetOptions[0]).toMatchObject({ height: 460 });
      expect(host.widgetRoots[0].style.height).toBe("100%");
      expect(host.widgetRoots[0].style.minHeight).toBe("0px");
      expect(host.dom.window.getComputedStyle(widget).overflowY).toBe("auto");
      widget.querySelector<HTMLButtonElement>('[data-role="settings"]')!.click();
      expect(host.drawerActivations()).toBe(1);
    } finally { dispose(); await host.close(); }
  });
  test("teardown still removes listeners when the host has already deactivated frontend messaging", async () => {
    const host = frontend(); const dispose = setup(host.context);
    try {
      await settle();
      host.context.sendToBackend = () => { throw new Error("SPINDLE_FRONTEND_INACTIVE"); };
      expect(() => dispose()).not.toThrow();
      expect(host.backendHandlers.size).toBe(0);
      expect(host.root.querySelectorAll(".dc-shell")).toHaveLength(0);
    } finally { dispose(); await host.close(); }
  });
});
