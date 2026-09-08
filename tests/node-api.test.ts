import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentRunOptions } from "../src/agent.js";
import type { AgentRegistry } from "../src/agent-registry.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow } from "../src/index.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";
import { loadFaux } from "./helpers/load-faux.js";

const INLINE_SCRIPT = `export const meta = {
  name: 'node_inline', description: 'Node inline API',
  phases: [{ title: 'routed', model: 'phase' }, { title: 'default' }]
}
phase('routed')
const exact = await agent('exact', { model: 'extension-fixture/exact' })
const tier = await agent('tier', { tier: 'small' })
const typed = await agent('typed', { agentType: 'fixture-type' })
const phased = await agent('phase')
phase('default')
const inherited = await agent('main')
return { exact, tier, typed, phased, inherited, args, cwd }`;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface NodeApiFixtureCustomization {
  extensionSource?: string;
  fixtureModels?: unknown[];
  defaultThinkingLevel?: string;
  tiers?: import("../src/model-tier-config.js").ModelTierConfig["tiers"];
}

async function withNodeApiFixture<T>(
  fn: (fixture: { cwd: string }) => Promise<T>,
  customization: NodeApiFixtureCustomization = {},
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "workflow-node-api-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "workflow-node-api-cwd-"));
  const agentDir = join(home, ".pi", "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(agentDir, { recursive: true });
  const extensionPath = join(cwd, "fixture-provider.mjs");
  writeFileSync(
    extensionPath,
    customization.extensionSource ??
      `export default function fixtureProvider(pi) {
  pi.registerProvider('extension-fixture', {
    name: 'Extension Fixture',
    baseUrl: 'https://invalid.example/v1',
    api: 'openai-completions',
    apiKey: 'extension-fixture-key-never-used',
    models: [{ id: 'exact', name: 'Exact', contextWindow: 4096, maxTokens: 1024 }],
  })
}
`,
  );
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fixture",
      defaultModel: "main",
      extensions: [extensionPath],
      ...(customization.defaultThinkingLevel ? { defaultThinkingLevel: customization.defaultThinkingLevel } : {}),
    }),
  );
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          name: "Fixture",
          baseUrl: "https://invalid.example/v1",
          api: "openai-completions",
          apiKey: "fixture-key-never-used",
          models:
            customization.fixtureModels ??
            ["main", "exact", "tier", "phase", "agent-type"].map((id) => ({
              id,
              name: id,
              contextWindow: 4096,
              maxTokens: 1024,
            })),
        },
      },
    }),
  );
  const workflowDir = join(home, ".pi", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(
    join(workflowDir, "model-tiers.json"),
    JSON.stringify({ tiers: customization.tiers ?? { small: "tier" } }),
  );

  try {
    return await withFakeHomeAsync(home, () => fn({ cwd }));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

test("object-form inline API owns model setup, propagates inputs, and waits for terminal completion", () =>
  withNodeApiFixture(async ({ cwd }) => {
    const release = deferred();
    const firstStarted = deferred();
    const seen: Array<{ prompt: string; model?: string; registry?: unknown }> = [];
    let settled = false;

    const promise = runWorkflow<{
      exact: string;
      tier: string;
      typed: string;
      phased: string;
      inherited: string;
      args: { topic: string };
      cwd: string;
    }>({
      script: INLINE_SCRIPT,
      args: { topic: "routing" },
      cwd,
      persistLogs: false,
      agentRegistry: new Map([
        [
          "fixture-type",
          {
            name: "fixture-type",
            model: "agent-type",
            prompt: "Use the fixture agent type.",
            source: "project",
          },
        ],
      ]) as AgentRegistry,
      agent: {
        async run(prompt: string, options: AgentRunOptions<any>) {
          seen.push({ prompt, model: options.model, registry: options.modelRegistry });
          if (prompt === "exact") {
            firstStarted.resolve();
            await release.promise;
          }
          return `done:${prompt}`;
        },
      },
    });
    void promise.then(() => {
      settled = true;
    });

    await firstStarted.promise;
    assert.equal(settled, false, "runWorkflow must remain pending while agent work is pending");
    release.resolve();
    const completed = await promise;

    assert.deepEqual(JSON.parse(JSON.stringify(completed.result)), {
      exact: "done:exact",
      tier: "done:tier",
      typed: "done:typed",
      phased: "done:phase",
      inherited: "done:main",
      args: { topic: "routing" },
      cwd,
    });
    assert.deepEqual(
      seen.map(({ prompt, model }) => ({ prompt, model })),
      [
        { prompt: "exact", model: "extension-fixture/exact" },
        { prompt: "tier", model: "fixture/tier" },
        { prompt: "typed", model: "fixture/agent-type" },
        { prompt: "phase", model: "fixture/phase" },
        { prompt: "main", model: "fixture/main" },
      ],
    );
    assert.ok(seen[0]?.registry, "the injected runner receives the automatically loaded Pi model registry");
    assert.ok(
      seen.every((call) => call.registry === seen[0]?.registry),
      "one run shares one model registry",
    );
    assert.equal(completed.agentCount, 5);
  }));

test("object-form API binds Pi project settings to cwd", () =>
  withNodeApiFixture(
    async ({ cwd }) => {
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({ defaultProvider: "fixture", defaultModel: "project-main" }),
      );
      let selectedModel: string | undefined;

      const completed = await runWorkflow({
        script: `export const meta = { name: 'project_settings', description: 'project settings' }
return await agent('project default')`,
        cwd,
        persistLogs: false,
        agent: {
          async run(_prompt: string, options: AgentRunOptions<any>) {
            selectedModel = options.model;
            return "project-result";
          },
        },
      });

      assert.equal(selectedModel, "fixture/project-main");
      assert.equal(completed.result, "project-result");
    },
    {
      fixtureModels: ["main", "project-main"].map((id) => ({
        id,
        name: id,
        contextWindow: 4096,
        maxTokens: 1024,
      })),
    },
  ));

test("object-form API reuses one composed model runtime while isolating real subagent extension sessions", async () => {
  const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await loadFaux();
  const faux = registerFauxProvider({
    provider: "fixture",
    models: [
      { id: "main", name: "Main", contextWindow: 4096, maxTokens: 1024, reasoning: true },
      { id: "tier", name: "Tier", contextWindow: 4096, maxTokens: 1024, reasoning: true },
    ],
  });
  const markerProvider = "runtime-probe";
  const sessionProvider = "session-probe";
  const extensionSource = `const state = { instances: 0 }
export default function runtimeProbe(pi) {
  const instance = ++state.instances
  const providerConfig = (id) => ({
    name: id,
    baseUrl: 'https://invalid.example/v1',
    api: 'openai-completions',
    apiKey: 'probe-key-never-used',
    models: [{ id, name: id, contextWindow: 4096, maxTokens: 1024 }],
  })
  pi.registerProvider('${markerProvider}', providerConfig('instance-' + instance))
  pi.registerTool({
    name: 'runtime_probe',
    label: 'runtime_probe',
    description: 'Report runtime composition',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const all = ctx.modelRegistry.getAll()
      const sawPreviousSession = all.some((model) => model.provider === '${sessionProvider}')
      if (instance === 2) pi.registerProvider('${sessionProvider}', providerConfig('from-first-session'))
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            instance,
            markerModels: all.filter((model) => model.provider === '${markerProvider}').map((model) => model.id),
            sawPreviousSession,
            cwd: ctx.cwd,
            thinking: ctx.thinkingLevel,
          }),
        }],
        details: {},
      }
    },
  })
}
`;

  const requestedModels: string[] = [];
  const echoToolResult = (context: unknown, _options: unknown, _state: unknown, requestModel: { id: string }) => {
    requestedModels.push(requestModel.id);
    const messages = (context as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
    const toolResult = [...messages].reverse().find((message) => message.role === "toolResult");
    const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
    const text = content.find((part): part is { type: "text"; text: string } => {
      return Boolean(
        part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      );
    })?.text;
    if (!text) throw new Error("runtime_probe did not produce a text tool result");
    return fauxAssistantMessage(text, { stopReason: "stop" });
  };
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("runtime_probe", {}), { stopReason: "toolUse" }),
    echoToolResult,
    fauxAssistantMessage(fauxToolCall("runtime_probe", {}), { stopReason: "toolUse" }),
    echoToolResult,
  ] as never);

  try {
    await withNodeApiFixture(
      async ({ cwd }) => {
        const completed = await runWorkflow<
          Array<{
            instance: number;
            markerModels: string[];
            sawPreviousSession: boolean;
            cwd: string;
            thinking: string;
          }>
        >({
          script: `export const meta = { name: 'runtime_ownership', description: 'runtime ownership' }
const first = await agent('probe first real session')
const second = await agent('probe second real session')
return [JSON.parse(first), JSON.parse(second)]`,
          cwd,
          mainModel: "fixture/tier",
          persistLogs: false,
        });

        assert.deepEqual(JSON.parse(JSON.stringify(completed.result)), [
          {
            instance: 2,
            markerModels: ["instance-2"],
            sawPreviousSession: false,
            cwd,
            thinking: "high",
          },
          {
            instance: 3,
            markerModels: ["instance-3"],
            sawPreviousSession: true,
            cwd,
            thinking: "high",
          },
        ]);
        assert.deepEqual(requestedModels, ["tier", "tier"]);
        assert.equal(faux.state.callCount, 4);
      },
      {
        extensionSource,
        fixtureModels: faux.models,
        defaultThinkingLevel: "high",
      },
    );
  } finally {
    faux.unregister();
  }
});

test("object-form scriptPath resolves from cwd and runs trusted native ESM imports", () =>
  withNodeApiFixture(async ({ cwd }) => {
    writeFileSync(
      join(cwd, "shared.mjs"),
      `export async function finish(context) {
  await new Promise((resolve) => setTimeout(resolve, 5))
  return { args: context.args, cwd: context.cwd }
}
`,
    );
    writeFileSync(
      join(cwd, "workflow.mjs"),
      `import { finish } from './shared.mjs'
export const meta = { name: 'node_file', description: 'Node file API' }
export async function run(context) { return finish(context) }
`,
    );

    const completed = await runWorkflow<{ args: { target: string }; cwd: string }>({
      scriptPath: "./workflow.mjs",
      args: { target: "native" },
      cwd,
      persistLogs: false,
    });

    assert.deepEqual(completed.result, { args: { target: "native" }, cwd });
    assert.equal(completed.meta.name, "node_file");
  }));

test("object-form API rejects missing, ambiguous, and unusable workflow sources", async () => {
  await assert.rejects(() => runWorkflow({} as never), /exactly one of script or scriptPath/i);
  await assert.rejects(
    () => runWorkflow({ script: "export const meta = {}", scriptPath: "workflow.mjs" } as never),
    /exactly one of script or scriptPath/i,
  );
  await assert.rejects(() => runWorkflow({ script: "" } as never), /script must be a non-empty string/i);
  await assert.rejects(() => runWorkflow({ scriptPath: "" } as never), /scriptPath must be a non-empty string/i);
  await assert.rejects(
    () => runWorkflow({ script: "export const meta = {}", scriptPath: 123 } as never),
    /exactly one of script or scriptPath/i,
  );

  await withNodeApiFixture(async ({ cwd }) => {
    await assert.rejects(
      () => runWorkflow({ script: "not a workflow", cwd, mainModel: "missing/main", persistLogs: false }),
      (error: unknown) => error instanceof SyntaxError,
    );
  });
});

test("object-form API rejects an ambiguous bare mainModel before workflow execution", () =>
  withNodeApiFixture(async ({ cwd }) => {
    let scriptStarted = false;

    await assert.rejects(
      () =>
        runWorkflow({
          script: `export const meta = { name: 'bare_main', description: 'bare main model' }
log('started')
return 'wrong'`,
          cwd,
          mainModel: "main",
          persistLogs: false,
          onLog: () => {
            scriptStarted = true;
          },
        }),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        /must be an exact provider\/modelId/i.test(error.message),
    );
    assert.equal(scriptStarted, false);
  }));

test("object-form API fails unavailable explicit models before default agent work", async () => {
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const faux = registerFauxProvider({
    provider: "fixture",
    models: [{ id: "main", name: "Main", contextWindow: 4096, maxTokens: 1024 }],
  });
  faux.setResponses([fauxAssistantMessage("wrong model ran", { stopReason: "stop" })]);

  try {
    await withNodeApiFixture(
      async ({ cwd }) => {
        await assert.rejects(
          () =>
            runWorkflow({
              script: `export const meta = { name: 'unavailable', description: 'unavailable model' }
return await agent('must not start', { model: 'missing/model' })`,
              cwd,
              mainModel: "fixture/main",
              persistLogs: false,
            }),
          (error: unknown) =>
            error instanceof WorkflowError &&
            error.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR &&
            /missing\/model.*unavailable or unauthenticated/i.test(error.message),
        );
        assert.equal(faux.state.callCount, 0, "an unavailable route must not run the configured default model");

        let injectedCalls = 0;
        await assert.rejects(
          () =>
            runWorkflow({
              script: `export const meta = { name: 'unavailable_injected', description: 'unavailable injected model' }
return await agent('injected must not start', { model: 'missing/model' })`,
              cwd,
              persistLogs: false,
              agent: {
                async run() {
                  injectedCalls++;
                  return "wrong";
                },
              },
            }),
          (error: unknown) =>
            error instanceof WorkflowError &&
            error.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR &&
            /missing\/model.*unavailable or unauthenticated/i.test(error.message),
        );
        assert.equal(injectedCalls, 0, "an unavailable route must not reach an injected runner");

        await assert.rejects(
          () =>
            runWorkflow({
              script: `export const meta = { name: 'stale_tier', description: 'stale configured tier' }
return await agent('configured tier must not degrade', { tier: 'small' })`,
              cwd,
              persistLogs: false,
              agent: {
                async run() {
                  injectedCalls++;
                  return "wrong";
                },
              },
            }),
          (error: unknown) =>
            error instanceof WorkflowError &&
            error.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR &&
            /tier.*unavailable or unauthenticated/i.test(error.message),
        );
        assert.equal(injectedCalls, 0, "a stale configured tier must fail instead of degrading to the default model");

        let scriptStarted = false;
        await assert.rejects(
          () =>
            runWorkflow({
              script: `export const meta = { name: 'unavailable_main', description: 'unavailable main model' }
log('started')
return 'wrong'`,
              cwd,
              mainModel: "missing/main",
              persistLogs: false,
              onLog: () => {
                scriptStarted = true;
              },
            }),
          (error: unknown) =>
            error instanceof WorkflowError &&
            error.code === WorkflowErrorCode.AGENT_EXECUTION_ERROR &&
            /missing\/main.*unavailable or unauthenticated/i.test(error.message),
        );
        assert.equal(scriptStarted, false, "an unavailable explicit mainModel must fail before workflow execution");
      },
      { fixtureModels: faux.models },
    );
  } finally {
    faux.unregister();
  }
});

test("object-form API preserves exact fallback routing and rejects ambiguous backups", () =>
  withNodeApiFixture(async ({ cwd }) => {
    const selected: Array<{ model?: string; fallbackModel?: string }> = [];
    const runner = {
      async run(_prompt: string, options: AgentRunOptions<any>) {
        selected.push({ model: options.model, fallbackModel: options.fallbackModel });
        return options.model === "fixture/exact" ? "primary" : "fallback";
      },
    };
    const available = await runWorkflow({
      script: `export const meta = { name: 'available_primary', description: 'available primary' }
return await agent('available', { model: 'fixture/exact', fallbackModel: 'fixture/tier' })`,
      cwd,
      persistLogs: false,
      agent: runner,
    });
    const fallback = await runWorkflow({
      script: `export const meta = { name: 'declared_fallback', description: 'declared fallback' }
return await agent('fallback', { model: 'missing/model', fallbackModel: 'fixture/tier' })`,
      cwd,
      persistLogs: false,
      agent: runner,
    });
    await assert.rejects(
      () =>
        runWorkflow({
          script: `export const meta = { name: 'ambiguous_fallback', description: 'ambiguous fallback' }
return await agent('ambiguous', { model: 'missing/model', fallbackModel: 'tier' })`,
          cwd,
          persistLogs: false,
          agent: runner,
        }),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR &&
        /fallback model.*must be an exact provider\/modelId/i.test(error.message),
    );

    assert.deepEqual(selected, [
      { model: "fixture/exact", fallbackModel: "fixture/tier" },
      { model: "fixture/tier", fallbackModel: undefined },
    ]);
    assert.equal(available.result, "primary");
    assert.equal(fallback.result, "fallback");
    assert.ok(
      fallback.logs.some((line) => /continuing on fixture\/tier/i.test(line)),
      "the wrapper must preserve the fallback notice",
    );
  }));

test("object-form API performs no module or Pi setup for an already-aborted signal", () =>
  withNodeApiFixture(
    async ({ cwd }) => {
      writeFileSync(
        join(cwd, "aborted-workflow.mjs"),
        `import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
writeFileSync(fileURLToPath(new URL('./workflow-loaded', import.meta.url)), '')
export const meta = { name: 'already_aborted', description: 'must not load' }
export async function run() { return 'wrong' }
`,
      );
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () =>
          runWorkflow({
            scriptPath: "./aborted-workflow.mjs",
            cwd,
            signal: controller.signal,
            persistLogs: false,
          }),
        (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_ABORTED,
      );
      assert.equal(existsSync(join(cwd, "workflow-loaded")), false);
      assert.equal(existsSync(join(cwd, "extension-loaded")), false);
    },
    {
      extensionSource: `import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
writeFileSync(fileURLToPath(new URL('./extension-loaded', import.meta.url)), '')
export default function fixtureProvider() {}
`,
    },
  ));

test("object-form API propagates AbortSignal cancellation and workflow errors", () =>
  withNodeApiFixture(async ({ cwd }) => {
    const controller = new AbortController();
    const started = deferred();
    const running = runWorkflow({
      script: `export const meta = { name: 'abort', description: 'abort propagation' }
return await agent('wait')`,
      cwd,
      mainModel: "fixture/main",
      signal: controller.signal,
      persistLogs: false,
      agent: {
        async run(_prompt: string, options: AgentRunOptions<any>) {
          started.resolve();
          return new Promise<string>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("agent observed abort")), { once: true });
          });
        },
      },
    });
    await started.promise;
    controller.abort();
    await assert.rejects(
      () => running,
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === WorkflowErrorCode.WORKFLOW_ABORTED &&
        error.details instanceof Error &&
        /agent observed abort/i.test(error.details.message),
    );

    writeFileSync(
      join(cwd, "complete-after-abort.mjs"),
      `export const meta = { name: 'complete_after_abort', description: 'completion wins abort race' }
export async function run({ args }) {
  args.abort()
  return 'completed-result'
}
`,
    );
    const completionController = new AbortController();
    const completed = await runWorkflow({
      scriptPath: "./complete-after-abort.mjs",
      cwd,
      signal: completionController.signal,
      args: { abort: () => completionController.abort() },
      persistLogs: false,
    });
    assert.equal(completed.result, "completed-result");

    await assert.rejects(
      () =>
        runWorkflow({
          script: `export const meta = { name: 'error', description: 'error propagation' }
throw new Error('node-api-boom')`,
          cwd,
          persistLogs: false,
        }),
      /node-api-boom/,
    );
  }));

test("root runWorkflow keeps the legacy script/options signature", async () => {
  const seen: string[] = [];
  const completed = await runWorkflow(
    `export const meta = { name: 'legacy', description: 'legacy signature' }
return await agent('legacy prompt')`,
    {
      args: { unchanged: true },
      persistLogs: false,
      agent: {
        async run(prompt: string) {
          seen.push(prompt);
          return "legacy-result";
        },
      },
    },
  );

  assert.deepEqual(seen, ["legacy prompt"]);
  assert.equal(completed.result, "legacy-result");
  assert.equal(completed.meta.name, "legacy");
});

test("real SDK sessions receive tier effort, explicit overrides, and session defaults", async () => {
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const seen: unknown[] = [];
  const faux = registerFauxProvider({
    provider: "fixture",
    models: ["main", "astra"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 4096, maxTokens: 1024 })),
  });
  faux.setResponses(
    Array.from({ length: 5 }, () => (_context: unknown, options: unknown) => {
      seen.push((options as { reasoning?: string }).reasoning);
      return fauxAssistantMessage("ok");
    }),
  );
  try {
    await withNodeApiFixture(
      async ({ cwd }) => {
        const started: unknown[] = [];
        const models: string[] = [];
        await runWorkflow({
          script: `export const meta = { name: 'tier_effort', description: 'tier effort' }
await agent('one', { tier: 'medium' })
await agent('two', { tier: 'big' })
await agent('three', { tier: 'medium', thinking: 'high' })
await agent('four', { tier: 'medium', model: 'fixture/main' })
await agent('five', { tier: 'small' })`,
          cwd,
          persistLogs: false,
          onAgentStart: (event) => started.push(event.thinking),
          onAgentModel: (event) => models.push(event.model),
        });
        assert.deepEqual(started, ["low", "medium", "high", undefined, undefined]);
        assert.deepEqual(seen, ["low", "medium", "high", "high", "high"]);
        assert.deepEqual(models, ["fixture/astra", "fixture/astra", "fixture/astra", "fixture/main", "fixture/main"]);
      },
      {
        fixtureModels: faux.models,
        defaultThinkingLevel: "high",
        tiers: {
          small: "fixture/main",
          medium: { model: "fixture/astra", thinking: "low" },
          big: { model: "fixture/astra", thinking: "medium" },
        },
      },
    );
  } finally {
    faux.unregister();
  }
});

test("real SDK tier fallback drops tier effort, retains explicit effort, and restores persisted pairs", async () => {
  const { WorkflowAgent } = await import("../src/agent.js");
  const { createAgentSessionServices, ModelRegistry, SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const seen: unknown[] = [];
  const faux = registerFauxProvider({
    provider: "fixture",
    models: ["main", "astra"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 4096, maxTokens: 1024 })),
  });
  faux.setResponses(
    Array.from({ length: 6 }, () => (_context: unknown, options: unknown) => {
      seen.push((options as { reasoning?: string }).reasoning);
      return fauxAssistantMessage("ok");
    }),
  );
  try {
    await withNodeApiFixture(
      async ({ cwd }) => {
        const services = await createAgentSessionServices({ cwd });
        const agent = new WorkflowAgent({
          cwd,
          modelRegistry: new ModelRegistry(services.modelRuntime),
          session: { modelRuntime: services.modelRuntime, settingsManager: services.settingsManager },
        });
        const models: string[] = [];
        await agent.run("default fallback", { tier: "medium" });
        await agent.run("explicit fallback", { tier: "medium", thinking: "medium" });
        await agent.run("backup fallback", { tier: "medium", fallbackModel: "fixture/main" });
        const sessionPath = join(cwd, "saved.jsonl");
        await agent.run("persist low", { sessionPath, modelSelection: { model: "fixture/main", thinking: "low" } });
        await agent.run("continue medium", {
          sessionPath,
          modelSelection: { model: "fixture/astra", thinking: "medium" },
        });
        await agent.run("restore", {
          sessionPath,
          restoreSessionModel: true,
          tier: "small",
          onModelResolved: (model) => models.push(model),
        });
        const saved = SessionManager.open(sessionPath).buildSessionContext();
        assert.equal(saved.model?.modelId, "astra");
        assert.equal(saved.thinkingLevel, "medium");
        assert.deepEqual(models, ["fixture/astra"]);
        assert.deepEqual(seen, ["high", "medium", "high", "low", "medium", "medium"]);
      },
      {
        fixtureModels: faux.models,
        defaultThinkingLevel: "high",
        tiers: { medium: { model: "missing/model", thinking: "low" } },
      },
    );
  } finally {
    faux.unregister();
  }
});

test("queued real SDK calls use one tier pair despite a config edit", async () => {
  const { saveModelTierConfig } = await import("../src/model-tier-config.js");
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const seen: unknown[] = [];
  const faux = registerFauxProvider({
    provider: "fixture",
    models: ["main", "astra"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 4096, maxTokens: 1024 })),
  });
  faux.setResponses(
    Array.from({ length: 2 }, () => (_context: unknown, options: unknown) => {
      seen.push((options as { reasoning?: string }).reasoning);
      saveModelTierConfig({ tiers: { medium: { model: "fixture/main", thinking: "medium" } } });
      return fauxAssistantMessage("ok");
    }),
  );
  try {
    await withNodeApiFixture(
      async ({ cwd }) => {
        const models: string[] = [];
        await runWorkflow({
          cwd,
          concurrency: 1,
          persistLogs: false,
          script: `export const meta = {name: 'queued_sdk', description: 'queued sdk'}
return await Promise.all([agent('first', {tier: 'medium'}), agent('second', {tier: 'medium'})])`,
          onAgentModel: (event) => models.push(event.model),
        });
        assert.deepEqual(models, ["fixture/astra", "fixture/astra"]);
        assert.deepEqual(seen, ["low", "low"]);
      },
      {
        fixtureModels: faux.models,
        defaultThinkingLevel: "high",
        tiers: { medium: { model: "fixture/astra", thinking: "low" } },
      },
    );
  } finally {
    faux.unregister();
  }
});

test("runtime tier fallback matches initial fallback effort and retains tool/transcript state", async () => {
  const { WorkflowAgent } = await import("../src/agent.js");
  const { saveModelTierConfig } = await import("../src/model-tier-config.js");
  const { createAgentSessionServices, ModelRegistry, SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { readFileSync, copyFileSync } = await import("node:fs");
  const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await loadFaux();
  const cases = [
    { global: "high", expected: "high", error: "Codex usage limit reached (plus plan). Resets in ~3h." },
    { expected: "medium", error: "401 unauthorized" },
    { global: "high", perModel: "medium", expected: "medium", error: "503 Service Unavailable" },
    { global: "high", explicit: "low", expected: "low", error: "Codex usage limit reached (plus plan)." },
    { global: "high", session: "medium", expected: "medium", error: "401 unauthorized" },
    { global: "medium", saved: "high", expected: "high", error: "401 unauthorized" },
    { global: "medium", saved: "high", suppliedManager: true, expected: "high", error: "401 unauthorized" },
  ] as const;
  for (const scenario of cases) {
    const config = scenario as {
      global?: string;
      perModel?: "medium";
      explicit?: "low";
      session?: "medium";
      saved?: "high";
      suppliedManager?: boolean;
      expected: string;
      error: string;
    };
    const faux = registerFauxProvider({
      provider: "fixture",
      models: ["main", "astra"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 4096, maxTokens: 1024 })),
    });
    try {
      await withNodeApiFixture(
        async ({ cwd }) => {
          const services = await createAgentSessionServices({ cwd });
          services.settingsManager.setRetryEnabled(false);
          if (config.perModel) services.settingsManager.setModelThinkingLevel("fixture", "main", config.perModel);
          const makeAgent = (sessionManager?: InstanceType<typeof SessionManager>) =>
            new WorkflowAgent({
              cwd,
              modelRegistry: new ModelRegistry(services.modelRuntime),
              session: {
                modelRuntime: services.modelRuntime,
                settingsManager: services.settingsManager,
                ...(config.session ? { thinkingLevel: config.session } : {}),
                ...(sessionManager ? { sessionManager } : {}),
              },
            });
          let agent = makeAgent();
          const sessionPath = join(cwd, "handoff.jsonl");
          const initialSessionPath = join(cwd, "initial.jsonl");
          if (config.saved) {
            faux.setResponses([fauxAssistantMessage("seed")]);
            await agent.run("seed", { model: "fixture/main", thinking: config.saved, sessionPath });
            copyFileSync(sessionPath, initialSessionPath);
          }
          let initialEffort: string | undefined;
          faux.setResponses([
            (_context: unknown, options: { reasoning?: string }) => {
              initialEffort = options.reasoning;
              return fauxAssistantMessage("initial");
            },
          ]);
          const opts = {
            tier: "medium",
            fallbackModel: "fixture/main",
            ...(config.explicit ? { thinking: config.explicit } : {}),
          };
          saveModelTierConfig({ tiers: { medium: { model: "missing/model", thinking: "low" } } });
          const initialAgent = config.suppliedManager ? makeAgent(SessionManager.open(initialSessionPath)) : agent;
          await initialAgent.run("task", { ...opts, ...(config.saved ? { sessionPath: initialSessionPath } : {}) });
          if (config.suppliedManager) agent = makeAgent(SessionManager.open(sessionPath));
          assert.equal(initialEffort, config.expected);
          saveModelTierConfig({ tiers: { medium: { model: "fixture/astra", thinking: "low" } } });
          const artifact = join(cwd, "completed-work.txt");
          const requests: Array<{ model: string; thinking?: string }> = [];
          let fallbackMessages: Array<{ role: string; toolName?: string }> = [];
          const capture =
            (response: unknown) =>
            (_context: unknown, options: { reasoning?: string }, _state: unknown, model: { id: string }) => {
              requests.push({ model: model.id, thinking: options.reasoning });
              return response;
            };
          faux.setResponses([
            capture(
              fauxAssistantMessage(fauxToolCall("write", { path: artifact, content: "completed once" }), {
                stopReason: "toolUse",
              }),
            ),
            capture(fauxAssistantMessage("", { stopReason: "error", errorMessage: config.error })),
            (
              context: { messages: typeof fallbackMessages },
              options: { reasoning?: string },
              _state: unknown,
              model: { id: string },
            ) => {
              requests.push({ model: model.id, thinking: options.reasoning });
              fallbackMessages = context.messages;
              return fauxAssistantMessage("continued");
            },
          ]);
          assert.equal(
            await agent.run("task", {
              ...opts,
              sessionPath: config.suppliedManager ? join(cwd, "unused.jsonl") : sessionPath,
            }),
            "continued",
          );
          assert.deepEqual(requests, [
            { model: "astra", thinking: "low" },
            { model: "astra", thinking: "low" },
            { model: "main", thinking: initialEffort },
          ]);
          assert.equal(readFileSync(artifact, "utf8"), "completed once");
          assert.equal(
            fallbackMessages.filter((message) => message.role === "toolResult" && message.toolName === "write").length,
            1,
          );
          const saved = SessionManager.open(sessionPath).buildSessionContext();
          assert.equal(saved.model?.modelId, "main");
          assert.equal(saved.thinkingLevel, initialEffort);
        },
        { fixtureModels: faux.models, defaultThinkingLevel: config.global },
      );
    } finally {
      faux.unregister();
    }
  }
});

test("low-level injected runner retains its main model before implicit and missing tiers", async () => {
  const { WorkflowAgent } = await import("../src/agent.js");
  const { createAgentSessionServices, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  const faux = registerFauxProvider({
    provider: "fixture",
    models: ["main", "astra"].map((id) => ({ id, name: id, reasoning: true, contextWindow: 4096, maxTokens: 1024 })),
  });
  const requests: string[] = [];
  faux.setResponses(
    Array.from({ length: 3 }, () => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
      requests.push(model.id);
      return fauxAssistantMessage("ok");
    }),
  );
  try {
    await withNodeApiFixture(
      async ({ cwd }) => {
        const services = await createAgentSessionServices({ cwd });
        const agent = new WorkflowAgent({
          cwd,
          mainModel: "fixture/astra",
          modelRegistry: new ModelRegistry(services.modelRuntime),
          session: { modelRuntime: services.modelRuntime, settingsManager: services.settingsManager },
        });
        await runWorkflow(
          `export const meta = { name: 'injected', description: 'injected routing' }
await agent('untagged')
await agent('missing', { tier: 'small' })
await agent('explicit', { model: 'fixture/main' })`,
          { cwd, agent, persistLogs: false },
        );
        assert.deepEqual(requests, ["astra", "astra", "main"]);
      },
      { fixtureModels: faux.models, tiers: { medium: "fixture/main" } },
    );
  } finally {
    faux.unregister();
  }
});

test("real SDK fallback display follows the effective pair through manager and navigator", async () => {
  const { WorkflowAgent } = await import("../src/agent.js");
  const { WorkflowManager } = await import("../src/workflow-manager.js");
  const { NavigatorModel, openWorkflowNavigator } = await import("../src/workflow-ui.js");
  const { createAgentSessionServices, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const { registerFauxProvider, fauxAssistantMessage } = await loadFaux();
  for (const route of ["normal", "initial", "default", "runtime"] as const) {
    for (const explicit of [false, true]) {
      const faux = registerFauxProvider({
        provider: "fixture",
        models: ["main", "astra"].map((id) => ({
          id,
          name: id,
          reasoning: true,
          contextWindow: 4096,
          maxTokens: 1024,
        })),
      });
      try {
        await withNodeApiFixture(
          async ({ cwd }) => {
            const services = await createAgentSessionServices({ cwd });
            const registry = new ModelRegistry(services.modelRuntime);
            const manager = new WorkflowManager({
              cwd,
              mainModel: "fixture/main",
              modelRegistry: registry,
              agent: new WorkflowAgent({
                cwd,
                mainModel: "fixture/main",
                modelRegistry: registry,
                session: { modelRuntime: services.modelRuntime, settingsManager: services.settingsManager },
              }),
            });
            const navigator = new NavigatorModel(manager);
            type Overlay = { render(width: number): string[]; handleInput(data: string): void; dispose(): void };
            let component: Overlay | undefined;
            let screen = "";
            let startingScreen = "";
            const requestRender = () => {
              assert.ok(component);
              screen = component.render(100).join("\n");
            };
            manager.once("agentStart", () => {
              void openWorkflowNavigator({} as Parameters<typeof openWorkflowNavigator>[0], manager, {
                custom(factory: (...args: unknown[]) => Overlay) {
                  component = factory(
                    { requestRender, terminal: { rows: 30 } },
                    {
                      fg: (_color: string, text: string) => text,
                      bg: (_color: string, text: string) => text,
                      bold: (text: string) => text,
                    },
                    {},
                    () => {},
                  );
                  component.handleInput("\r");
                  component.handleInput("\r");
                  startingScreen = screen;
                  return Promise.resolve();
                },
              } as unknown as Parameters<typeof openWorkflowNavigator>[2]);
            });
            const observed: Array<{ model: string; thinking?: string }> = [];
            const capture =
              (fail: boolean) =>
              (
                _context: unknown,
                options: { reasoning?: string },
                _state: unknown,
                model: { provider: string; id: string },
              ) => {
                const actual = { model: `${model.provider}/${model.id}`, thinking: options.reasoning };
                observed.push(actual);
                // No input or direct render here: only manager notifications refresh the open overlay.
                assert.ok(screen.includes(`${model.id} · ${options.reasoning}`), screen);
                const run = manager.listRuns()[0];
                const live = manager.getRun(run.runId);
                assert.ok(live);
                const snapshot = live.snapshot.agents[0];
                assert.deepEqual({ model: snapshot.model, thinking: snapshot.thinking }, actual);
                const row = navigator.agents(run.runId, "(no phase)")[0];
                assert.deepEqual({ model: row.model, thinking: row.thinking }, actual);
                const detail = navigator.agentDetail(run.runId, row.id);
                assert.ok(detail);
                assert.deepEqual({ model: detail.model, thinking: detail.thinking }, actual);
                return fail
                  ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" })
                  : fauxAssistantMessage("ok");
              };
            faux.setResponses(route === "runtime" ? [capture(true), capture(false)] : [capture(false)]);
            const run =
              manager.startInBackground(`export const meta = { name: 'display_pair', description: 'display pair' }
return await agent('task', { tier: 'medium'${route === "default" ? "" : ", fallbackModel: 'fixture/main'"}${explicit ? ", thinking: 'medium'" : ""} })`);
            try {
              await run.promise;
              assert.ok(startingScreen.includes(`main · ${explicit ? "medium" : "low"}`), startingScreen);
            } finally {
              component?.dispose();
            }
            const tierPair = { model: "fixture/astra", thinking: explicit ? "medium" : "low" };
            const fallbackPair = { model: "fixture/main", thinking: explicit ? "medium" : "high" };
            assert.deepEqual(
              observed,
              route === "runtime"
                ? [tierPair, fallbackPair]
                : [route === "initial" || route === "default" ? fallbackPair : tierPair],
            );
            const persistedNavigator = new NavigatorModel({
              listRuns: () => manager.listRuns(),
              getRun: () => undefined,
            });
            const persisted = persistedNavigator.agents(run.runId, "(no phase)")[0];
            assert.deepEqual({ model: persisted.model, thinking: persisted.thinking }, observed.at(-1));
          },
          {
            fixtureModels: faux.models,
            defaultThinkingLevel: "high",
            tiers: {
              medium: {
                model: route === "initial" || route === "default" ? "missing/model" : "fixture/astra",
                thinking: "low",
              },
            },
          },
        );
      } finally {
        faux.unregister();
      }
    }
  }
});
