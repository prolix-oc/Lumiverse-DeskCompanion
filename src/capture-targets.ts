import type { DesktopCaptureDevice } from "lumiverse-spindle-types";
import { record, safeLabel } from "./protocol";
import type { DeviceOption } from "./protocol";

/** Keep the native picker for window capture and saved settings from older desktops. */
export function captureTargets(devices: DesktopCaptureDevice[], now: number): DeviceOption[] {
  return devices.filter(device => device.expiresAt > now).flatMap(device => {
    const picker: DeviceOption = { id: device.id, ...(device.stableIdentity === true ? { stableIdentity: true } : {}),
      name: safeLabel(device.name), platform: device.platform, image: device.capabilities.image, video: device.capabilities.video };
    // Feature detection also lets this extension build with older Spindle type packages.
    if (!("displays" in device) || !Array.isArray(device.displays)) return [picker];
    const displays = device.displays.filter(display => record(display) && typeof display.id === "string" && /^[a-f0-9]{64}$/.test(display.id)
      && typeof display.name === "string" && Number.isInteger(display.width) && Number(display.width) > 0
      && Number.isInteger(display.height) && Number(display.height) > 0 && typeof display.primary === "boolean");
    return [...displays.map(display => ({ ...picker, id: display.id as string, nativeDeviceId: device.id, displayId: display.id as string,
      name: `${safeLabel(device.name)} · ${safeLabel(display.name as string)} · ${display.width} × ${display.height}${display.primary ? " · Primary" : ""}` })),
      { ...picker, name: `${picker.name} · Choose a display or window in Desktop` }];
  });
}
