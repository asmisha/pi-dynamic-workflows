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
  writeFileSync(join(workflowDir, "model-tiers.json"), JSON.stringify({ tiers: { small: "tier" } }));

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
