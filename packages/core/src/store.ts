import type {
  HarnessEvent,
  HarnessEventDraft,
  HistoryOptions,
  HistoryPage,
  InteractionRequestId,
  InteractionSnapshot,
  SendRequest,
  SessionId,
  SessionSnapshot,
  SessionSummary,
  TurnId,
  TurnResult,
  TurnSummary,
} from "./types.js";

export interface SessionRecord extends SessionSummary {}

export interface TurnRecord extends TurnSummary {
  readonly request: SendRequest;
}

export interface RecoveryReport {
  readonly failedTurnIds: readonly TurnId[];
  readonly expiredInteractionIds: readonly InteractionRequestId[];
  readonly pausedTurnIds: readonly TurnId[];
}

export interface HarnessStore {
  open(): Promise<void>;
  recover(): Promise<RecoveryReport>;
  createSession(session: SessionRecord): Promise<HarnessEvent>;
  getSession(id: SessionId): Promise<SessionRecord | undefined>;
  listSessions(includeArchived: boolean): Promise<readonly SessionRecord[]>;
  archiveSession(id: SessionId): Promise<HarnessEvent>;
  deleteSession(id: SessionId): Promise<void>;
  acceptTurn(turn: TurnRecord): Promise<HarnessEvent>;
  appendEvent(draft: HarnessEventDraft): Promise<HarnessEvent>;
  getTurn(id: TurnId): Promise<TurnRecord | undefined>;
  listQueuedTurns(sessionId: SessionId): Promise<readonly TurnRecord[]>;
  setQueuedPaused(sessionId: SessionId, paused: boolean): Promise<void>;
  getInteraction(id: InteractionRequestId): Promise<InteractionSnapshot | undefined>;
  snapshot(sessionId: SessionId): Promise<SessionSnapshot>;
  history(sessionId: SessionId, options?: HistoryOptions): Promise<HistoryPage>;
  latestSequence(): Promise<number>;
  getProviderMetadata(sessionId: SessionId, key: string): Promise<unknown | undefined>;
  setProviderMetadata(sessionId: SessionId, key: string, value: unknown): Promise<void>;
  close(): Promise<void>;
}

export function resultForTurn(turn: TurnSummary): TurnResult | undefined {
  return turn.result;
}
