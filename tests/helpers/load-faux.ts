import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Load the pi-ai compat module used by pi-coding-agent in nested and deduped npm layouts. */
export async function loadFaux(): Promise<typeof import("@earendil-works/pi-ai/compat")> {
  const nested = fileURLToPath(
    new URL(
      "../../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/compat.js",
      import.meta.url,
    ),
  );
  const entry = existsSync(nested)
    ? nested
    : fileURLToPath(new URL("../../node_modules/@earendil-works/pi-ai/dist/compat.js", import.meta.url));
  return import(entry) as Promise<typeof import("@earendil-works/pi-ai/compat")>;
}
