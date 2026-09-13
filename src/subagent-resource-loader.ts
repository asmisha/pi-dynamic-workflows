import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

/** A session-local view: never remove extensions from a caller's shared loader. */
export function subagentResourceLoader(loader: ResourceLoader): ResourceLoader {
  return {
    getExtensions() {
      const result = loader.getExtensions();
      return {
        ...result,
        // OM's public command names identify it across local, npm, and git installs.
        // Excluding it before binding removes both background workers and its
        // compaction hook, leaving Pi's native compaction available.
        extensions: result.extensions.filter(
          (extension) => !(extension.commands.has("om:status") && extension.commands.has("om:view")),
        ),
      };
    },
    getSkills: () => loader.getSkills(),
    getPrompts: () => loader.getPrompts(),
    getThemes: () => loader.getThemes(),
    getAgentsFiles: () => loader.getAgentsFiles(),
    getSystemPrompt: () => loader.getSystemPrompt(),
    getSystemPromptSource: () => loader.getSystemPromptSource(),
    getAppendSystemPrompt: () => loader.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => loader.getAppendSystemPromptSources(),
    extendResources: (paths) => loader.extendResources(paths),
    reload: (options) => loader.reload(options),
  };
}
