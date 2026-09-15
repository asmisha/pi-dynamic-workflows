import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { runWorkflow } = await jiti.import("./src/node-api.ts");

export { runWorkflow };
