import type { SpindleAPI } from "lumiverse-spindle-types";
import { installCompanion } from "./worker";

declare const spindle: SpindleAPI;

export const dispose = installCompanion(spindle);
