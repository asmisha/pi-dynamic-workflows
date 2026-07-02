/**
 * Bottom progress-panel preference commands:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress-max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
  type WorkflowSettingsStore,
} from "./workflow-settings.js";

const DEFAULT_SETTINGS_STORE: WorkflowSettingsStore = {
  load: loadWorkflowSettings,
  save: saveWorkflowSettings,
};

export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom progress panel: compact | detailed | status",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (arg === "compact" || arg === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: arg });
        await say(
          saved
            ? `Workflow progress panel set to ${arg} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${arg} for this session, but the preference could not be saved.`,
        );
        return;
      }
      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)}. Usage: /workflows-progress compact | detailed | status`,
      );
    },
  });

  pi.registerCommand?.("workflows-progress-max", {
    description: "Max agents shown per phase in detailed progress mode (1-1000)",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (!arg) {
        await say(
          `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress-max <1-1000>`,
        );
        return;
      }
      const n = Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1) {
        await say(`Invalid value "${arg}". Usage: /workflows-progress-max <1-1000> (a whole number ≥ 1).`);
        return;
      }
      const clamped = Math.min(1000, n);
      const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
      await say(
        saved
          ? `Detailed progress now shows up to ${clamped} agents per phase.`
          : `Set to ${clamped} for this session, but the preference could not be saved.`,
      );
    },
  });
}

function persistProgressSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function loadProgressMode(settingsStore: WorkflowSettingsStore): "compact" | "detailed" {
  try {
    return settingsStore.load().progressPanelMode ?? "compact";
  } catch {
    return "compact";
  }
}

function loadProgressMaxAgents(settingsStore: WorkflowSettingsStore): number {
  try {
    return settingsStore.load().progressPanelMaxAgents ?? 8;
  } catch {
    return 8;
  }
}
