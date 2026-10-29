import type { SpindleFrontendContext, SpindleMountedComponent, SpindleSelectOptions } from "lumiverse-spindle-types";

// Additive Spindle 0.6.71 fields, usable before the SDK is published.
export interface PaginatedSelectOptions extends SpindleSelectOptions {
  forceSearch?: boolean; remoteSearch?: boolean; onSearchChange?: (query: string) => void;
  loading?: boolean; hasMore?: boolean; onLoadMore?: () => void; loadMoreOnScroll?: boolean;
  loadingMessage?: string; loadMoreLabel?: string;
}

interface FieldBinding { sync(force?: boolean): void; destroy(): void }

function bindField<Options extends object>(state: () => Options, mount: (options: Options) => SpindleMountedComponent<Options>): FieldBinding {
  const initial = state();
  const handle = mount(initial);
  let previous = JSON.stringify(initial);
  return {
    sync(force = false) { const next = state(); const serialized = JSON.stringify(next); if (force || previous !== serialized) { handle.update(next); previous = serialized; } },
    destroy: () => handle.destroy(),
  };
}

/** Keep the form's values and events while the host owns the visible controls. */
export function mountSharedFields(ctx: SpindleFrontendContext, root: HTMLElement, selectOptions?: (control: HTMLSelectElement) => Partial<PaginatedSelectOptions>): { sync(): void; destroy(): void } {
  const bindings: FieldBinding[] = [];
  const components = ctx.components;
  for (const control of root.querySelectorAll<HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement>("select,input,textarea")) {
    const target = document.createElement("span");
    target.className = "dc-control";
    control.after(target);
    let binding: FieldBinding | undefined;
    const emit = (value: string | number | boolean | null) => {
      if (control.disabled) return;
      if (control instanceof control.ownerDocument.defaultView!.HTMLInputElement && control.type === "checkbox") control.checked = Boolean(value);
      else {
        const text = value === null ? "" : String(value);
        const limit = control.tagName === "TEXTAREA" ? (control as HTMLTextAreaElement).maxLength : -1;
        control.value = limit < 0 ? text : text.slice(0, limit);
      }
      const Event = control.ownerDocument.defaultView!.Event;
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
      if (typeof value === "string" && control.value !== value) binding?.sync(true);
    };
    const ariaLabel = control.getAttribute("aria-label") ?? undefined;
    try {
      if (control.tagName === "SELECT" && components?.mountSelect) {
        const select = control as HTMLSelectElement;
        const state = () => ({ value: select.value, disabled: select.disabled,
          placeholder: select.options[0]?.value === "" ? select.options[0].textContent ?? "Choose…" : "Choose…",
          options: Array.from(select.options).filter((option) => option.value).map((option) => ({ value: option.value, label: option.textContent ?? option.value, disabled: option.disabled })), ...selectOptions?.(select) });
        binding = bindField(state, options => components.mountSelect(target, { ...options, ariaLabel, onChange: emit }));
      } else if (control.tagName === "TEXTAREA" && components?.mountTextArea) {
        binding = bindField(() => ({ value: control.value, disabled: control.disabled }),
          options => components.mountTextArea(target, { ...options, ariaLabel, rows: 3, placeholder: control.getAttribute("placeholder") ?? "", onChange: emit }));
      } else if (control.tagName === "INPUT" && (control as HTMLInputElement).type === "number" && components?.mountNumericInput) {
        const input = control as HTMLInputElement;
        binding = bindField(() => ({ value: input.value === "" ? null : Number(input.value), disabled: input.disabled }),
          options => components.mountNumericInput(target, { ...options, ariaLabel, min: Number(input.min), max: Number(input.max), step: 1, integer: true, onChange: emit }));
      } else if (control.tagName === "INPUT" && (control as HTMLInputElement).type === "checkbox" && components?.mountSwitch) {
        const input = control as HTMLInputElement;
        binding = bindField(() => ({ checked: input.checked, disabled: input.disabled }),
          options => components.mountSwitch(target, { ...options, ariaLabel, size: "sm", onChange: emit }));
      }
      if (!binding) { target.remove(); continue; }
      control.hidden = true;
      const mounted = binding;
      bindings.push({ sync: force => mounted.sync(force), destroy() { mounted.destroy(); target.remove(); control.hidden = false; } });
    } catch { binding?.destroy(); target.remove(); control.hidden = false; }
  }
  return { sync: () => { for (const binding of bindings) binding.sync(); }, destroy: () => { for (const binding of bindings.splice(0).reverse()) binding.destroy(); } };
}

export function mountSharedBadge(ctx: SpindleFrontendContext, fallback: HTMLElement): { sync(): void; destroy(): void } {
  if (!ctx.components?.mountBadge) return { sync() {}, destroy() {} };
  const target = document.createElement("span");
  target.className = "dc-badge-host";
  fallback.after(target);
  try {
    const state = () => ({ text: fallback.textContent ?? "", color: fallback.dataset.busy === "true" ? "primary" as const : fallback.textContent === "Ready" ? "success" as const : "neutral" as const, size: "pill" as const });
    const handle = ctx.components.mountBadge(target, state());
    fallback.hidden = true;
    let previous = JSON.stringify(state());
    return { sync() { const next = state(); if (JSON.stringify(next) !== previous) { handle.update(next); previous = JSON.stringify(next); } }, destroy() { handle.destroy(); target.remove(); fallback.hidden = false; } };
  } catch { target.remove(); return { sync() {}, destroy() {} }; }
}

export function mountSharedSections(ctx: SpindleFrontendContext, root: HTMLElement): () => void {
  const cleanups: Array<() => void> = [];
  if (ctx.components?.mountCollapsibleSection) for (const details of root.querySelectorAll<HTMLDetailsElement>("details[data-shared-section]")) {
    const summary = details.querySelector("summary")!;
    const target = document.createElement("div");
    details.before(target);
    try {
      const handle = ctx.components.mountCollapsibleSection(target, { title: summary.textContent ?? "Help", defaultExpanded: details.open });
      for (const child of Array.from(details.childNodes)) if (child !== summary) handle.body.append(child);
      details.remove();
      cleanups.push(() => { handle.destroy(); target.remove(); });
    } catch { target.remove(); }
  }
  return () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); };
}
