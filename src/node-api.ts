import { resolve } from "node:path";
import { createAgentSessionServices, ModelRegistry, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { assertAgentModelAvailable, createFailClosedModelAgent, isExactModelSpec, WorkflowAgent } from "./agent.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import {
  loadWorkflowModule,
  parseWorkflowScript,
  runWorkflow as runWorkflowScript,
  type WorkflowRunOptions,
  type WorkflowRunResult,
} from "./workflow.js";

type OneShotWorkflowRunOptions = Omit<
  WorkflowRunOptions,
  | "initialTokenUsage"
  | "modelRegistry"
  | "onAgentFailureEscaped"
  | "onAgentJournal"
  | "onRuntimeOwnedWorkStart"
  | "restoreAgentSessionModel"
  | "resumeFromRunId"
  | "resumeJournal"
  | "retryFailedCallIds"
  | "session"
  | "workflowModule"
>;

type InlineWorkflowSource = {
  /** Inline workflow source whose first statement exports literal `meta`. */
  script: string;
  scriptPath?: never;
};

type FileWorkflowSource = {
  script?: never;
  /** Trusted native ESM entry point, resolved against `cwd` (or process.cwd()). */
  scriptPath: string;
};

/** Options for the awaited, one-shot Node `runWorkflow({ ... })` API. */
export type RunWorkflowOptions = OneShotWorkflowRunOptions & (InlineWorkflowSource | FileWorkflowSource);

function configuredMainModel(settings: SettingsManager): string | undefined {
  const provider = settings.getDefaultProvider();
  const model = settings.getDefaultModel();
  return provider && model ? `${provider}/${model}` : undefined;
}

function assertExactModelSpec(spec: string): void {
  if (isExactModelSpec(spec)) return;
  throw new WorkflowError(
    `Model "${spec}" must be an exact provider/modelId`,
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
}

function aborted(): WorkflowError {
  return new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
}

/** Preserve the original script/options API. */
export function runWorkflow<T = unknown>(script: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult<T>>;
/** Run an inline or file-backed workflow with Pi runtime setup owned by this call. */
export function runWorkflow<T = unknown>(options: RunWorkflowOptions): Promise<WorkflowRunResult<T>>;
export async function runWorkflow<T = unknown>(
  scriptOrOptions: string | RunWorkflowOptions,
  legacyOptions: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  if (typeof scriptOrOptions === "string") {
    return runWorkflowScript<T>(scriptOrOptions, legacyOptions);
  }
  if (!scriptOrOptions || typeof scriptOrOptions !== "object" || Array.isArray(scriptOrOptions)) {
    throw new TypeError("runWorkflow() expects a workflow script string or an options object");
  }

  const scriptProvided = scriptOrOptions.script !== undefined;
  const scriptPathProvided = scriptOrOptions.scriptPath !== undefined;
  if (scriptProvided === scriptPathProvided) {
    throw new TypeError("runWorkflow() options must provide exactly one of script or scriptPath");
  }
  if (scriptProvided && (typeof scriptOrOptions.script !== "string" || !scriptOrOptions.script.trim())) {
    throw new TypeError("runWorkflow() option script must be a non-empty string");
  }
  if (scriptPathProvided && (typeof scriptOrOptions.scriptPath !== "string" || !scriptOrOptions.scriptPath.trim())) {
    throw new TypeError("runWorkflow() option scriptPath must be a non-empty string");
  }

  const { script, scriptPath, ...options } = scriptOrOptions;
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.signal?.aborted) throw aborted();
  if (options.mainModel !== undefined) assertExactModelSpec(options.mainModel);
  if (scriptProvided) parseWorkflowScript(script as string);
  const workflowModule = scriptPathProvided ? await loadWorkflowModule(resolve(cwd, scriptPath as string)) : undefined;
  if (options.signal?.aborted) throw aborted();

  const services = await createAgentSessionServices({ cwd });
  const modelRegistry = new ModelRegistry(services.modelRuntime);
  if (options.signal?.aborted) throw aborted();
  const mainModel = options.mainModel ?? configuredMainModel(services.settingsManager);
  if (options.mainModel !== undefined) assertAgentModelAvailable(options.mainModel, modelRegistry);

  const baseAgent =
    options.agent ??
    new WorkflowAgent({
      cwd,
      tools: options.tools,
      instructions: options.instructions,
      mainModel,
      modelRegistry,
      session: {
        agentDir: services.agentDir,
        modelRuntime: services.modelRuntime,
        settingsManager: services.settingsManager,
      },
    });
  const agent = createFailClosedModelAgent(baseAgent, mainModel, modelRegistry);

  try {
    return await runWorkflowScript<T>(script ?? "", {
      ...options,
      cwd,
      mainModel,
      modelRegistry,
      agent,
      workflowModule,
    });
  } catch (error) {
    if (!options.signal?.aborted) throw error;
    const wrapped = wrapError(error);
    if (wrapped.code === WorkflowErrorCode.WORKFLOW_ABORTED) throw wrapped;
    throw new WorkflowError(wrapped.message, WorkflowErrorCode.WORKFLOW_ABORTED, {
      recoverable: true,
      details: error,
      agentLabel: wrapped.agentLabel,
      resetHint: wrapped.resetHint,
      callId: wrapped.callId,
    });
  }
}
