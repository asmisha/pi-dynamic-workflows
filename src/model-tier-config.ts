/**
 * Model tier configuration for workflow subagent model routing.
 *
 * A tier is a named slot (small/medium/big) holding one model spec and optional thinking level
 * (e.g. "openai/gpt-4.1-mini"). When an agent() call specifies
 * opts.tier, that single model is resolved and used as the subagent's model
 * (unless an explicit opts.model is given, which always wins — see agent.ts).
 *
 * This augments the phase-pattern routing in model-routing.ts: phase routing
 * maps workflow phases → models via the script's meta; tiers give scripts a
 * coarse, user-configurable small/medium/big knob that is independent of any
 * concrete provider/model id.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type AgentThinkingLevel, isAgentThinkingLevel, listAvailableModelSpecs } from "./agent.js";
import { MODEL_TIERS_FILE } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Model tier configuration. Maps tier names (e.g. "small", "medium", "big")
 * to a model spec string or an object with a model and optional thinking level.
 */
export type ModelTierEntry = string | { model: string; thinking?: AgentThinkingLevel };

export interface ModelTierConfig {
  tiers: Record<string, ModelTierEntry>;
}

// ---------------------------------------------------------------------------
// Configuration path
// ---------------------------------------------------------------------------

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
export function getModelTierConfigPath(): string {
  return join(homedir(), MODEL_TIERS_FILE);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Build a default tier config where every tier points at a single model —
 * the user's currently active Pi model when known, else the first available
 * model. New users get consistent behaviour (every tier == the model they're
 * already chatting with) and can refine tiers later via `/workflows-models`.
 */
export function buildDefaultTierConfig(currentModelSpec?: string): ModelTierConfig {
  const model = currentModelSpec ?? listAvailableModelSpecs()[0] ?? "";
  return {
    tiers: {
      small: model,
      medium: model,
      big: model,
    },
  };
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load the model tier config from disk. Returns null if the file does not
 * exist or is unparseable (callers fall back to a default).
 */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.tiers || typeof parsed.tiers !== "object") return null;
    for (const val of Object.values(parsed.tiers)) {
      if (typeof val === "string") continue;
      if (
        !val ||
        typeof val !== "object" ||
        Array.isArray(val) ||
        !("model" in val) ||
        typeof val.model !== "string" ||
        ("thinking" in val && !isAgentThinkingLevel(val.thinking))
      )
        return null;
    }
    return parsed as ModelTierConfig;
  } catch {
    return null;
  }
}

/**
 * Save a model tier config to disk. Creates parent directories if needed.
 */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Resolve / helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a tier name to its configured model spec, or undefined if the tier
 * is not configured.
 */
export function resolveTierModel(tier: string, config: ModelTierConfig): string | undefined {
  const entry = config.tiers[tier];
  return typeof entry === "string" ? entry : entry?.model;
}

/** Return all tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
