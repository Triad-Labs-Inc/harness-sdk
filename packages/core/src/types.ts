export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type EventId = Brand<string, "EventId">;
export type InteractionRequestId = Brand<string, "InteractionRequestId">;

export type RawEventPersistence = "none" | "errors" | "all";
export type PermissionMode = "supervised" | "full_access";

export type ProviderStatus =
  | { state: "ready"; version?: string }
  | { state: "not_installed"; message: string }
  | { state: "not_authenticated"; message: string }
  | { state: "unavailable"; message: string; cause?: unknown };

export interface ProviderCapabilities {
  readonly steering: boolean;
  readonly interruption: boolean;
  readonly permissions: boolean;
  readonly questions: boolean;
  readonly sessionResume: boolean;
  readonly modelOverride: boolean;
  readonly reasoningOverride: boolean;
  readonly rawEvents: boolean;
}

export interface HarnessErrorData {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type TurnResult =
  | { status: "completed" }
  | { status: "interrupted"; reason?: string }
  | {
      status: "failed";
      error: HarnessErrorData;
      mayHaveSideEffects: boolean;
    };

export type PermissionDecision =
  | { decision: "allow_once" }
  | { decision: "allow_session" }
  | { decision: "deny"; reason?: string }
  | { decision: "cancel_turn"; reason?: string };

export interface InputQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options?: readonly {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
  }[];
  readonly multiple?: boolean;
  readonly allowFreeText?: boolean;
}

export interface InputRequest {
  readonly id: InteractionRequestId;
  readonly title?: string;
  readonly questions: readonly InputQuestion[];
}

export interface InputResponse {
  readonly answers: Readonly<Record<string, readonly string[]>>;
}

export type SessionState = "active" | "archived";
export type TurnState = "queued" | "active" | "completed" | "failed" | "interrupted";

export interface SessionSummary {
  readonly id: SessionId;
  readonly provider: string;
  readonly cwd: string;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TurnSummary {
  readonly id: TurnId;
  readonly sessionId: SessionId;
  readonly state: TurnState;
  readonly text: string;
  readonly paused: boolean;
  readonly result?: TurnResult;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface MessageSnapshot {
  readonly id: string;
  readonly turnId: TurnId;
  readonly role: "assistant" | "user" | "system";
  readonly text: string;
  readonly completed: boolean;
  readonly sequence: number;
}

export interface InteractionSnapshot {
  readonly id: InteractionRequestId;
  readonly turnId: TurnId;
  readonly kind: "permission" | "input";
  readonly status: "pending" | "resolved" | "expired";
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SessionSnapshot {
  readonly sequence: number;
  readonly session: SessionSummary;
  readonly turns: readonly TurnSummary[];
  readonly messages: readonly MessageSnapshot[];
  readonly interactions: readonly InteractionSnapshot[];
}

interface EventDataMap {
  "session.created": { provider: string; cwd: string };
  "session.status_changed": { state: SessionState; reason?: string };
  "session.archived": Record<string, never>;
  "turn.queued": { text: string; paused: boolean };
  "turn.started": Record<string, never>;
  "turn.completed": Record<string, never>;
  "turn.failed": { error: HarnessErrorData; mayHaveSideEffects: boolean };
  "turn.interrupted": { reason?: string };
  "message.started": { messageId: string; role: "assistant" | "user" | "system" };
  "message.delta": { messageId: string; delta: string };
  "message.completed": { messageId: string; text?: string };
  "tool.started": { toolId: string; name: string; input?: unknown };
  "tool.updated": { toolId: string; update: unknown };
  "tool.completed": { toolId: string; output?: unknown; isError?: boolean };
  "permission.requested": {
    requestId: InteractionRequestId;
    title: string;
    toolName?: string;
    input?: unknown;
  };
  "permission.resolved": {
    requestId: InteractionRequestId;
    decision: PermissionDecision | "expired";
  };
  "input.requested": { requestId: InteractionRequestId; request: InputRequest };
  "input.resolved": { requestId: InteractionRequestId; response: InputResponse | "expired" };
  diagnostic: { level: "info" | "warning" | "error"; message: string; code?: string };
}

export type HarnessEventType = keyof EventDataMap;

export type HarnessEvent = {
  [Type in HarnessEventType]: Readonly<{
    id: EventId;
    schemaVersion: 1;
    sequence: number;
    sessionId: SessionId;
    turnId?: TurnId;
    type: Type;
    timestamp: string;
    data: Readonly<EventDataMap[Type]>;
    raw?: unknown;
  }>;
}[HarnessEventType];

export type HarnessEventDraft<Type extends HarnessEventType = HarnessEventType> = Readonly<{
  sessionId: SessionId;
  turnId?: TurnId;
  type: Type;
  data: EventDataMap[Type];
  raw?: unknown;
  timestamp?: string;
}>;

export interface HistoryOptions {
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface HistoryPage {
  readonly events: readonly HarnessEvent[];
  readonly nextSequence?: number;
  readonly hasMore: boolean;
}

export interface SubscriptionObserver {
  onEvent(event: HarnessEvent): void | Promise<void>;
  onError?(error: Error): void | Promise<void>;
}

export interface Subscription {
  close(): Promise<void>;
}

export interface SendRequest {
  readonly text: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly permissionMode?: PermissionMode;
}

export interface Turn {
  readonly id: TurnId;
  done(): Promise<TurnResult>;
}

export interface Session {
  readonly id: SessionId;
  readonly provider: string;
  readonly cwd: string;
  send(request: SendRequest): Promise<Turn>;
  steer(request: { text: string }): Promise<void>;
  interrupt(): Promise<void>;
  respondToPermission(requestId: InteractionRequestId, decision: PermissionDecision): Promise<void>;
  respondToInput(requestId: InteractionRequestId, response: InputResponse): Promise<void>;
  snapshot(): Promise<SessionSnapshot>;
  history(options?: HistoryOptions): Promise<HistoryPage>;
  subscribe(
    options: { afterSequence?: number },
    observer: SubscriptionObserver,
  ): Promise<Subscription>;
  resumeQueue(): Promise<void>;
  archive(): Promise<void>;
  delete(): Promise<void>;
}

export interface SessionCreateOptions {
  readonly provider: string;
  readonly cwd?: string;
}

export interface SessionManager {
  create(options: SessionCreateOptions): Promise<Session>;
  load(id: SessionId): Promise<Session>;
  list(options?: { includeArchived?: boolean }): Promise<readonly SessionSummary[]>;
}

export interface ProviderRegistration {
  status(): Promise<ProviderStatus>;
  capabilities(): Promise<ProviderCapabilities>;
}

export interface Harness {
  readonly sessions: SessionManager;
  readonly providers: Readonly<Record<string, ProviderRegistration>>;
  close(): Promise<void>;
}
