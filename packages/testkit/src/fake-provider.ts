import type {
  InputQuestion,
  PermissionDecision,
  ProviderAdapterV1,
  ProviderCapabilities,
  ProviderContext,
  ProviderEvent,
  ProviderInputResponse,
  ProviderPermissionResponse,
  ProviderRuntime,
  ProviderStatus,
  ProviderTurnRequest,
} from "@triadlabs/harness";

export type FakeProviderStep =
  | { type: "text"; chunks: readonly string[]; messageId?: string }
  | {
      type: "permission";
      id?: string;
      title?: string;
      toolName?: string;
      input?: unknown;
    }
  | {
      type: "input";
      id?: string;
      title?: string;
      questions: readonly InputQuestion[];
    }
  | { type: "tool"; id?: string; name: string; input?: unknown; output?: unknown }
  | { type: "delay"; ms: number }
  | { type: "diagnostic"; level?: "info" | "warning" | "error"; message: string }
  | { type: "crash"; message?: string }
  | { type: "fail"; code?: string; message?: string; mayHaveSideEffects?: boolean }
  | { type: "complete" };

export interface FakeProviderScript {
  readonly steps: readonly FakeProviderStep[];
}

class Signal {
  promise: Promise<void>;
  #resolve!: () => void;
  #settled = false;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  fire(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve();
  }
}

interface ActiveTurn {
  interrupted: boolean;
  signal: Signal;
  permissions: Map<string, (decision: PermissionDecision) => void>;
  inputs: Map<string, (response: ProviderInputResponse["response"]) => void>;
}

const defaultCapabilities: ProviderCapabilities = {
  steering: true,
  interruption: true,
  permissions: true,
  questions: true,
  sessionResume: true,
  modelOverride: true,
  reasoningOverride: true,
  rawEvents: true,
};

export class FakeProviderController {
  readonly scripts: FakeProviderScript[] = [];
  readonly starts: ProviderTurnRequest[] = [];
  readonly steering: string[] = [];
  readonly permissionResponses: ProviderPermissionResponse[] = [];
  readonly inputResponses: ProviderInputResponse[] = [];
  opened = 0;
  closed = 0;
  active = 0;
  maxActive = 0;
  status: ProviderStatus = { state: "ready", version: "fake-1" };
  capabilities: ProviderCapabilities = { ...defaultCapabilities };

  enqueue(...scripts: FakeProviderScript[]): void {
    this.scripts.push(...scripts);
  }

  script(...steps: FakeProviderStep[]): FakeProviderScript {
    return { steps };
  }
}

class FakeRuntime implements ProviderRuntime {
  readonly #controller: FakeProviderController;
  #active: ActiveTurn | undefined;
  #closed = false;

  constructor(controller: FakeProviderController) {
    this.#controller = controller;
    controller.opened++;
  }

  async *startTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent> {
    if (this.#closed) throw new Error("Fake runtime is closed");
    if (this.#active) throw new Error("Fake runtime already has an active turn");
    const active: ActiveTurn = {
      interrupted: false,
      signal: new Signal(),
      permissions: new Map(),
      inputs: new Map(),
    };
    this.#active = active;
    this.#controller.starts.push(structuredClone(request));
    this.#controller.active++;
    this.#controller.maxActive = Math.max(this.#controller.maxActive, this.#controller.active);
    const script = this.#controller.scripts.shift() ?? {
      steps: [{ type: "text", chunks: [request.text] }, { type: "complete" }],
    };
    let terminal = false;
    try {
      for (const [index, step] of script.steps.entries()) {
        if (active.interrupted) {
          terminal = true;
          yield { type: "turn.interrupted", reason: "Interrupted by application" };
          return;
        }
        switch (step.type) {
          case "text": {
            const messageId =
              step.messageId ?? `fake-message-${this.#controller.starts.length}-${index}`;
            yield { type: "message.started", messageId, role: "assistant", raw: { fake: true } };
            let text = "";
            for (const chunk of step.chunks) {
              if (active.interrupted) {
                terminal = true;
                yield { type: "turn.interrupted", reason: "Interrupted by application" };
                return;
              }
              text += chunk;
              yield { type: "message.delta", messageId, delta: chunk, raw: { chunk } };
            }
            yield { type: "message.completed", messageId, text, raw: { fake: true } };
            break;
          }
          case "permission": {
            const providerRequestId = step.id ?? `fake-permission-${index}`;
            const response = new Promise<PermissionDecision>((resolve) => {
              active.permissions.set(providerRequestId, resolve);
            });
            yield {
              type: "permission.requested",
              providerRequestId,
              title: step.title ?? "Allow fake tool?",
              ...(step.toolName === undefined ? {} : { toolName: step.toolName }),
              ...(step.input === undefined ? {} : { input: step.input }),
              raw: { providerRequestId },
            };
            const decision = await Promise.race([
              response,
              active.signal.promise.then(() => ({ decision: "cancel_turn" }) as PermissionDecision),
            ]);
            active.permissions.delete(providerRequestId);
            if (decision.decision === "cancel_turn" || active.interrupted) {
              terminal = true;
              yield { type: "turn.interrupted", reason: "Permission cancelled the turn" };
              return;
            }
            break;
          }
          case "input": {
            const providerRequestId = step.id ?? `fake-input-${index}`;
            const response = new Promise<ProviderInputResponse["response"]>((resolve) => {
              active.inputs.set(providerRequestId, resolve);
            });
            yield {
              type: "input.requested",
              providerRequestId,
              ...(step.title === undefined ? {} : { title: step.title }),
              questions: step.questions,
              raw: { providerRequestId },
            };
            await Promise.race([response, active.signal.promise]);
            active.inputs.delete(providerRequestId);
            if (active.interrupted) {
              terminal = true;
              yield { type: "turn.interrupted", reason: "Interrupted during input" };
              return;
            }
            break;
          }
          case "tool": {
            const toolId = step.id ?? `fake-tool-${index}`;
            yield {
              type: "tool.started",
              toolId,
              name: step.name,
              ...(step.input === undefined ? {} : { input: step.input }),
            };
            yield {
              type: "tool.completed",
              toolId,
              ...(step.output === undefined ? {} : { output: step.output }),
            };
            break;
          }
          case "delay": {
            await Promise.race([
              new Promise((resolve) => setTimeout(resolve, step.ms)),
              active.signal.promise,
            ]);
            break;
          }
          case "diagnostic":
            yield {
              type: "diagnostic",
              level: step.level ?? "info",
              message: step.message,
              raw: { message: step.message },
            };
            break;
          case "crash":
            throw new Error(step.message ?? "Injected fake provider crash");
          case "fail":
            terminal = true;
            yield {
              type: "turn.failed",
              code: step.code ?? "FAKE_FAILURE",
              message: step.message ?? "Injected fake provider failure",
              mayHaveSideEffects: step.mayHaveSideEffects ?? false,
              raw: { message: step.message ?? "Injected fake provider failure" },
            };
            return;
          case "complete":
            terminal = true;
            yield { type: "turn.completed", raw: { fake: true } };
            return;
        }
      }
      if (!terminal) yield { type: "turn.completed" };
    } finally {
      this.#controller.active--;
      if (this.#active === active) this.#active = undefined;
    }
  }

  async steer(request: { text: string }): Promise<void> {
    if (!this.#active) throw new Error("No active fake turn");
    this.#controller.steering.push(request.text);
  }

  async interrupt(): Promise<void> {
    if (!this.#active) return;
    this.#active.interrupted = true;
    this.#active.signal.fire();
  }

  async respondToPermission(response: ProviderPermissionResponse): Promise<void> {
    const resolve = this.#active?.permissions.get(response.providerRequestId);
    if (!resolve) throw new Error(`Unknown fake permission ${response.providerRequestId}`);
    this.#controller.permissionResponses.push(structuredClone(response));
    resolve(response.decision);
  }

  async respondToInput(response: ProviderInputResponse): Promise<void> {
    const resolve = this.#active?.inputs.get(response.providerRequestId);
    if (!resolve) throw new Error(`Unknown fake input ${response.providerRequestId}`);
    this.#controller.inputResponses.push(structuredClone(response));
    resolve(response.response);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.interrupt();
    this.#controller.closed++;
  }
}

export function fakeProvider(
  controller = new FakeProviderController(),
  id = "fake",
): ProviderAdapterV1 {
  return {
    apiVersion: 1,
    id,
    async status(_context: ProviderContext) {
      return structuredClone(controller.status);
    },
    async capabilities(_context: ProviderContext) {
      return structuredClone(controller.capabilities);
    },
    async openSession() {
      return new FakeRuntime(controller);
    },
  };
}
