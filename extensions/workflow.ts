import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createWorkflowPauseTool,
  createWorkflowStopTool,
  createWorkflowTool,
  installResultDelivery,
  installTaskPanel,
  loadWorkflowSettings,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  registerWorkflowProgressCommands,
  saveWorkflowSettingsForCwd,
  WorkflowManager,
} from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  // Single manager shared by the workflow tool and the /workflows command, so
  // background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  const settings = loadWorkflowSettings({ cwd });
  const manager = new WorkflowManager({
    cwd,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
  });

  const workflowTool = createWorkflowTool({ cwd, manager });
  const workflowPauseTool = createWorkflowPauseTool(manager);
  const workflowStopTool = createWorkflowStopTool(manager);
  pi.registerTool(workflowTool);
  pi.registerTool(workflowPauseTool);
  pi.registerTool(workflowStopTool);
  const workflowToolNames = [workflowTool.name, workflowPauseTool.name, workflowStopTool.name];
  registerWorkflowCommands(pi, manager);
  registerWorkflowModelsCommand(pi);
  registerWorkflowProgressCommands(pi, {
    load: () => loadWorkflowSettings({ cwd }),
    save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
  });

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    // Tell the manager the session's main model so "explore" agents auto-tier
    // down to a lighter same-family sibling (e.g. Claude → Haiku).
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    // Share the host session's model registry so tier/phase routing resolves
    // extension-registered providers (e.g. ollama-cloud) consistently. Set it
    // before activating the tool: the tool's promptGuidelines read the
    // manager's registry lazily, so tool-registry refreshes from here on
    // advertise the shared registry's models.
    manager.setModelRegistry(ctx.modelRegistry);
    const active = pi.getActiveTools();
    const missing = workflowToolNames.filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
    // Scope the /workflows history to this session: runs persist on disk across
    // sessions, but the navigator/task panel show only the current session's runs.
    // Switching back to a previous session re-shows that session's runs.
    try {
      manager.setSessionId(ctx.sessionManager?.getSessionId());
    } catch {
      // sessionManager may be unavailable in some contexts — fall back to global history.
    }
    // Deliver a background run's result into the conversation when it finishes.
    installResultDelivery(pi, manager);
    // Live "workflows running" panel below the input.
    installTaskPanel(pi, manager, ctx.ui, { loadSettings: () => loadWorkflowSettings({ cwd }) });
  });
}
