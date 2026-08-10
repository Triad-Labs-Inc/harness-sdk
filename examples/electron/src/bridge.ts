import type {
  HarnessEvent,
  HistoryPage,
  InputResponse,
  PermissionDecision,
  ProviderStatus,
  SessionId,
  SessionSnapshot,
  SessionSummary,
  TurnId,
  TurnResult,
} from "@triadlabs/harness";

export interface BootstrapData {
  readonly providers: Readonly<Record<string, ProviderStatus>>;
  readonly sessions: readonly SessionSummary[];
}

export interface HarnessRendererApi {
  bootstrap(): Promise<BootstrapData>;
  createSession(provider: string): Promise<SessionSnapshot>;
  snapshot(sessionId: SessionId): Promise<SessionSnapshot>;
  history(sessionId: SessionId, afterSequence?: number): Promise<HistoryPage>;
  subscribe(sessionId: SessionId, afterSequence: number): Promise<void>;
  send(sessionId: SessionId, text: string): Promise<TurnId>;
  interrupt(sessionId: SessionId): Promise<void>;
  respondToPermission(
    sessionId: SessionId,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<void>;
  respondToInput(sessionId: SessionId, requestId: string, response: InputResponse): Promise<void>;
  onEvent(listener: (event: HarnessEvent) => void): () => void;
  onTurnResult(listener: (value: { turnId: TurnId; result: TurnResult }) => void): () => void;
}

declare global {
  interface Window {
    harness: HarnessRendererApi;
  }
}
