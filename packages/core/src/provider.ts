import type {
  InputQuestion,
  InputResponse,
  PermissionDecision,
  ProviderCapabilities,
  ProviderStatus,
  SendRequest,
  SessionId,
  TurnId,
} from "./types.js";

export interface ProviderContext {
  readonly homeDir: string;
  registerSecrets(values: readonly string[]): void;
}

export interface OpenSessionContext extends ProviderContext {
  readonly sessionId: SessionId;
  readonly cwd: string;
  getMetadata(key: string): Promise<unknown | undefined>;
  setMetadata(key: string, value: unknown): Promise<void>;
}

export interface ProviderTurnRequest extends SendRequest {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}

export type ProviderEvent =
  | {
      type: "message.started";
      messageId: string;
      role?: "assistant" | "user" | "system";
      raw?: unknown;
    }
  | { type: "message.delta"; messageId: string; delta: string; raw?: unknown }
  | { type: "message.completed"; messageId: string; text?: string; raw?: unknown }
  | { type: "tool.started"; toolId: string; name: string; input?: unknown; raw?: unknown }
  | { type: "tool.updated"; toolId: string; update: unknown; raw?: unknown }
  | { type: "tool.completed"; toolId: string; output?: unknown; isError?: boolean; raw?: unknown }
  | {
      type: "permission.requested";
      providerRequestId: string;
      title: string;
      toolName?: string;
      input?: unknown;
      raw?: unknown;
    }
  | {
      type: "input.requested";
      providerRequestId: string;
      title?: string;
      questions: readonly InputQuestion[];
      raw?: unknown;
    }
  | { type: "turn.completed"; raw?: unknown }
  | { type: "turn.interrupted"; reason?: string; raw?: unknown }
  | {
      type: "turn.failed";
      code: string;
      message: string;
      mayHaveSideEffects: boolean;
      raw?: unknown;
    }
  | {
      type: "diagnostic";
      level: "info" | "warning" | "error";
      message: string;
      code?: string;
      raw?: unknown;
    };

export interface ProviderPermissionResponse {
  readonly providerRequestId: string;
  readonly decision: PermissionDecision;
}

export interface ProviderInputResponse {
  readonly providerRequestId: string;
  readonly response: InputResponse;
}

export interface ProviderRuntime {
  startTurn(request: ProviderTurnRequest): AsyncIterable<ProviderEvent>;
  steer?(request: { text: string }): Promise<void>;
  interrupt?(): Promise<void>;
  respondToPermission?(response: ProviderPermissionResponse): Promise<void>;
  respondToInput?(response: ProviderInputResponse): Promise<void>;
  close(): Promise<void>;
}

export interface ProviderAdapterV1 {
  readonly apiVersion: 1;
  readonly id: string;
  status(context: ProviderContext): Promise<ProviderStatus>;
  capabilities(context: ProviderContext): Promise<ProviderCapabilities>;
  openSession(context: OpenSessionContext): Promise<ProviderRuntime>;
}
