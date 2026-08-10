import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createHarness,
  createMemoryStore,
  InMemoryStore,
  ProviderUnavailableError,
  SessionDeletedError,
  SessionNotFoundError,
  SlowConsumerError,
  UnsupportedAdapterVersionError,
  UnsupportedCapabilityError,
  type HarnessEventDraft,
  type HarnessEvent,
  type ProviderAdapterV1,
} from "@triadlabs/harness";
import { describe, expect, it } from "vitest";

import { fakeProvider, FakeProviderController } from "./fake-provider.js";

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("core event and lifecycle contracts", () => {
  it("rejects unsupported adapter contract versions during construction", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-adapter-version-"));
    const invalid = {
      ...fakeProvider(new FakeProviderController()),
      apiVersion: 2,
    } as unknown as ProviderAdapterV1;
    await expect(
      createHarness({ homeDir, providers: { invalid }, store: createMemoryStore() }),
    ).rejects.toBeInstanceOf(UnsupportedAdapterVersionError);
  });

  it("rejects availability and capability failures before accepting a turn", async () => {
    const unavailableHome = await mkdtemp(join(tmpdir(), "harness-unavailable-"));
    const unavailableController = new FakeProviderController();
    unavailableController.status = { state: "not_authenticated", message: "fixture auth" };
    const unavailableHarness = await createHarness({
      homeDir: unavailableHome,
      providers: { fake: fakeProvider(unavailableController) },
      store: createMemoryStore(),
    });
    const unavailableSession = await unavailableHarness.sessions.create({ provider: "fake" });
    await expect(unavailableSession.send({ text: "must not be accepted" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect((await unavailableSession.history({ limit: 100 })).events).toHaveLength(1);
    await unavailableHarness.close();

    const capabilityHome = await mkdtemp(join(tmpdir(), "harness-capability-"));
    const capabilityController = new FakeProviderController();
    capabilityController.capabilities = {
      ...capabilityController.capabilities,
      modelOverride: false,
    };
    const capabilityHarness = await createHarness({
      homeDir: capabilityHome,
      providers: { fake: fakeProvider(capabilityController) },
      store: createMemoryStore(),
    });
    const capabilitySession = await capabilityHarness.sessions.create({ provider: "fake" });
    await expect(
      capabilitySession.send({ text: "must not be accepted", model: "unsupported" }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect((await capabilitySession.history({ limit: 100 })).events).toHaveLength(1);
    await capabilityHarness.close();
  });

  it("delivers a concurrent subscription-start event exactly once", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-subscribe-"));
    const controller = new FakeProviderController();
    controller.enqueue(controller.script({ type: "delay", ms: 25 }, { type: "complete" }));
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: createMemoryStore(),
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    const snapshot = await session.snapshot();
    const events: HarnessEvent[] = [];
    const subscriptionPromise = session.subscribe(
      { afterSequence: snapshot.sequence },
      { onEvent: (event) => void events.push(event) },
    );
    const turnPromise = session.send({ text: "concurrent" });
    const [subscription, turn] = await Promise.all([subscriptionPromise, turnPromise]);
    await turn.done();
    await waitFor(() => events.some((event) => event.type === "turn.completed"));
    expect(new Set(events.map((event) => event.sequence)).size).toBe(events.length);
    expect(events.filter((event) => event.type === "turn.queued")).toHaveLength(1);
    await subscription.close();
    await harness.close();
  });

  it("disconnects a slow consumer and replays after its safe sequence", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-slow-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      controller.script(
        ...Array.from({ length: 10 }, (_, index) => ({
          type: "diagnostic" as const,
          message: `event-${index}`,
        })),
        { type: "complete" },
      ),
    );
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: createMemoryStore(),
      subscriberBufferSize: 2,
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowError: SlowConsumerError | undefined;
    let resolveError!: () => void;
    const errorSeen = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const snapshot = await session.snapshot();
    await session.subscribe(
      { afterSequence: snapshot.sequence },
      {
        onEvent: () => blocked,
        onError: (error) => {
          slowError = error as SlowConsumerError;
          resolveError();
        },
      },
    );
    await (await session.send({ text: "overflow" })).done();
    await errorSeen;
    expect(slowError).toBeInstanceOf(SlowConsumerError);
    release();

    const replayed: HarnessEvent[] = [];
    const replay = await session.subscribe(
      { afterSequence: slowError!.lastSequence },
      { onEvent: (event) => void replayed.push(event) },
    );
    await waitFor(() => replayed.some((event) => event.type === "turn.completed"));
    expect(replayed.every((event) => event.sequence > slowError!.lastSequence)).toBe(true);
    await replay.close();
    await harness.close();
  });

  it("redacts registered environment secrets from raw events and logs", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-redact-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      controller.script(
        { type: "text", chunks: ["env-secret-value"] },
        {
          type: "tool",
          name: "fixture",
          input: { authorization: "env-secret-value", visible: "env-secret-value" },
          output: { token: "env-secret-value", visible: "env-secret-value" },
        },
        { type: "diagnostic", level: "error", message: "failed with env-secret-value" },
        { type: "complete" },
      ),
    );
    const base = fakeProvider(controller);
    const adapter: ProviderAdapterV1 = {
      ...base,
      async status(context) {
        context.registerSecrets(["env-secret-value"]);
        return await base.status(context);
      },
    };
    const harness = await createHarness({
      homeDir,
      providers: { fake: adapter },
      rawEvents: "all",
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    await (await session.send({ text: "redact" })).done();
    const history = await session.history({ limit: 100 });
    expect(JSON.stringify(history)).not.toContain("env-secret-value");
    await harness.close();
    const logs = await readFile(join(homeDir, "logs", "harness.log"), "utf8");
    expect(logs).not.toContain("env-secret-value");
    const database = await readFile(join(homeDir, "harness.sqlite3"));
    expect(database.includes(Buffer.from("env-secret-value"))).toBe(false);
  });

  it("persists raw payloads only for failures and diagnostics in errors mode", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-raw-errors-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      controller.script(
        { type: "text", chunks: ["ordinary output"] },
        { type: "diagnostic", level: "info", message: "ordinary diagnostic" },
        { type: "diagnostic", level: "error", message: "error diagnostic" },
        { type: "fail", message: "turn failure" },
      ),
    );
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: createMemoryStore(),
      rawEvents: "errors",
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    await (await session.send({ text: "raw errors" })).done();
    const events = (await session.history({ limit: 100 })).events;
    expect(events.find((event) => event.type === "message.completed")?.raw).toBeUndefined();
    expect(
      events.find((event) => event.type === "diagnostic" && event.data.level === "info")?.raw,
    ).toEqual({ message: "ordinary diagnostic" });
    expect(
      events.find((event) => event.type === "diagnostic" && event.data.level === "error")?.raw,
    ).toEqual({ message: "error diagnostic" });
    expect(events.find((event) => event.type === "turn.failed")?.raw).toEqual({
      message: "turn failure",
    });
    await harness.close();
  });

  it("archives, lists, and transactionally deletes sessions through public APIs", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-session-lifecycle-"));
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(new FakeProviderController()) },
      store: createMemoryStore(),
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    let subscriptionError: Error | undefined;
    let resolveSubscriptionError!: () => void;
    const subscriptionFailed = new Promise<void>((resolve) => {
      resolveSubscriptionError = resolve;
    });
    await session.subscribe(
      { afterSequence: (await session.snapshot()).sequence },
      {
        onEvent: () => undefined,
        onError: (error) => {
          subscriptionError = error;
          resolveSubscriptionError();
        },
      },
    );

    await session.archive();
    expect((await harness.sessions.list()).map((item) => item.id)).not.toContain(session.id);
    expect(await harness.sessions.list({ includeArchived: true })).toContainEqual(
      expect.objectContaining({ id: session.id, state: "archived" }),
    );
    expect((await session.history({ limit: 100 })).events.at(-1)?.type).toBe("session.archived");

    await session.delete();
    await subscriptionFailed;
    expect(subscriptionError).toBeInstanceOf(SessionDeletedError);
    await expect(harness.sessions.load(session.id)).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(session.send({ text: "after deletion" })).rejects.toBeInstanceOf(
      SessionDeletedError,
    );
    expect(await harness.sessions.list({ includeArchived: true })).toEqual([]);
    await harness.close();
  });

  it("settles accepted work deterministically after a storage write failure", async () => {
    class FailOnceStore extends InMemoryStore {
      #failed = false;

      override async appendEvent(draft: HarnessEventDraft) {
        if (!this.#failed && draft.type === "turn.started") {
          this.#failed = true;
          throw new Error("injected storage failure");
        }
        return await super.appendEvent(draft);
      }
    }

    const homeDir = await mkdtemp(join(tmpdir(), "harness-storage-failure-"));
    const controller = new FakeProviderController();
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: new FailOnceStore(),
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    await expect((await session.send({ text: "must settle" })).done()).resolves.toMatchObject({
      status: "failed",
      error: { code: "STORE_WRITE_FAILED" },
      mayHaveSideEffects: true,
    });
    expect(controller.starts).toHaveLength(0);
    await harness.close();
  });

  it("suspends an idle runtime and resumes with a fresh runtime", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-idle-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      controller.script({ type: "complete" }),
      controller.script({ type: "complete" }),
    );
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: createMemoryStore(),
      idleTimeoutMs: 5,
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    await (await session.send({ text: "first" })).done();
    await waitFor(() => controller.closed === 1);
    await (await session.send({ text: "second" })).done();
    expect(controller.opened).toBe(2);
    await harness.close();
    expect(controller.closed).toBe(2);
  });

  it("settles paused queued handles when closing after a provider crash", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-crash-close-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      controller.script({ type: "crash", message: "first crashed" }),
      controller.script({ type: "complete" }),
    );
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: createMemoryStore(),
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    const first = await session.send({ text: "crash" });
    const queued = await session.send({ text: "must remain queued" });
    await expect(first.done()).resolves.toMatchObject({ status: "failed" });
    expect(controller.starts).toHaveLength(1);
    await harness.close();
    await expect(queued.done()).resolves.toMatchObject({
      status: "failed",
      error: { code: "HARNESS_CLOSED" },
      mayHaveSideEffects: false,
    });
    expect(controller.starts).toHaveLength(1);
  });

  it("expires an unresolved interaction when the provider crashes", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-interaction-crash-"));
    const base = fakeProvider(new FakeProviderController());
    const adapter: ProviderAdapterV1 = {
      ...base,
      async openSession() {
        return {
          async *startTurn() {
            yield {
              type: "permission.requested" as const,
              providerRequestId: "native-pending",
              title: "Pending permission",
            };
            throw new Error("provider exited with callback pending");
          },
          async close() {},
        };
      },
    };
    const harness = await createHarness({
      homeDir,
      providers: { fake: adapter },
      store: createMemoryStore(),
    });
    const session = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    await expect(
      (await session.send({ text: "crash during interaction" })).done(),
    ).resolves.toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_CRASHED" },
    });
    const snapshot = await session.snapshot();
    expect(snapshot.interactions).toEqual([
      expect.objectContaining({ kind: "permission", status: "expired" }),
    ]);
    await harness.close();
  });

  it("keeps independent sessions concurrent while serializing each session", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-concurrent-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      controller.script({ type: "delay", ms: 40 }, { type: "complete" }),
      controller.script({ type: "delay", ms: 40 }, { type: "complete" }),
    );
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: new InMemoryStore(),
    });
    const first = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    const second = await harness.sessions.create({ provider: "fake", cwd: homeDir });
    const turns = await Promise.all([
      first.send({ text: "first" }),
      second.send({ text: "second" }),
    ]);
    await Promise.all(turns.map((turn) => turn.done()));
    expect(controller.maxActive).toBe(2);
    await harness.close();
  });

  it("stress-runs concurrent sessions without duplicate durable events", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "harness-stress-"));
    const controller = new FakeProviderController();
    controller.enqueue(
      ...Array.from({ length: 20 }, (_, index) =>
        controller.script(
          { type: "delay", ms: 2 + (index % 4) },
          { type: "diagnostic", message: `session-${index}` },
          { type: "complete" },
        ),
      ),
    );
    const harness = await createHarness({
      homeDir,
      providers: { fake: fakeProvider(controller) },
      store: createMemoryStore(),
    });
    const sessions = await Promise.all(
      Array.from({ length: 20 }, () => harness.sessions.create({ provider: "fake", cwd: homeDir })),
    );
    const observed: HarnessEvent[] = [];
    const subscriptions = await Promise.all(
      sessions.map(async (session) => {
        const snapshot = await session.snapshot();
        return await session.subscribe(
          { afterSequence: snapshot.sequence },
          { onEvent: (event) => void observed.push(event) },
        );
      }),
    );
    const turns = await Promise.all(
      sessions.map((session, index) => session.send({ text: `turn-${index}` })),
    );
    await Promise.all(turns.map((turn) => turn.done()));
    await waitFor(
      () => observed.filter((event) => event.type === "turn.completed").length === sessions.length,
    );
    expect(controller.maxActive).toBeGreaterThan(1);
    expect(new Set(observed.map((event) => event.sequence)).size).toBe(observed.length);
    for (const session of sessions) {
      const history = await session.history({ limit: 100 });
      const sequences = history.events.map((event) => event.sequence);
      expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
      expect(history.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    }
    await Promise.all(subscriptions.map((subscription) => subscription.close()));
    await harness.close();
  });
});
