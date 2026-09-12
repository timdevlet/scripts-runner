// The renderer's view of the preload bridge, derived from the implementation so any drift fails
// `npm run typecheck`. Type-only import — the preload module itself must never be loaded here.
import type { AppAPI } from "../../preload.js";

declare global {
  interface Window {
    appAPI: AppAPI;
  }
}
