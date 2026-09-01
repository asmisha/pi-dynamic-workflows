import { tsImport } from "tsx/esm/api";

const { runWorkflow } = await tsImport("./src/node-api.ts", {
  parentURL: import.meta.url,
  tsconfig: false,
});

export { runWorkflow };
