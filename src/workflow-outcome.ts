export function workflowOutcome(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  const state = result.continuationState;
  const candidate =
    result.outcome ??
    (state && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>).outcome
      : undefined);
  return typeof candidate === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : undefined;
}
