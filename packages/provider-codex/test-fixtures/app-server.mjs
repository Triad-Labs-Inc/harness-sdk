import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextTurn = 0;
let active;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function complete(status = "completed", error = null) {
  if (!active) return;
  send({
    method: "turn/completed",
    params: {
      threadId: "fixture-thread",
      turn: { id: active.id, status, error, items: [], itemsView: "notLoaded" },
    },
  });
  active = undefined;
}

function stream(chunks = ["one", "two"]) {
  const messageId = `message-${nextTurn}`;
  send({
    method: "item/started",
    params: {
      threadId: "fixture-thread",
      turnId: active.id,
      item: { type: "agentMessage", id: messageId, text: "", phase: null, memoryCitation: null },
    },
  });
  for (const delta of chunks) {
    send({
      method: "item/agentMessage/delta",
      params: { threadId: "fixture-thread", turnId: active.id, itemId: messageId, delta },
    });
  }
  send({
    method: "item/completed",
    params: {
      threadId: "fixture-thread",
      turnId: active.id,
      item: {
        type: "agentMessage",
        id: messageId,
        text: chunks.join(""),
        phase: null,
        memoryCitation: null,
      },
    },
  });
  complete();
}

function startScenario(text) {
  if (text === "crash") {
    setTimeout(() => process.exit(17), 5);
    return;
  }
  if (text === "unknown") {
    send({
      method: "fixture/newNotification",
      params: { threadId: "fixture-thread", additive: true },
    });
    complete();
    return;
  }
  if (text === "failed") {
    complete("failed", { message: "fixture reported failure" });
    return;
  }
  if (text === "tools") {
    const item = {
      type: "commandExecution",
      id: `tool-${nextTurn}`,
      command: "fixture",
      cwd: "<fixture>",
      status: "completed",
    };
    send({
      method: "item/started",
      params: { threadId: "fixture-thread", turnId: active.id, item },
    });
    send({
      method: "item/completed",
      params: { threadId: "fixture-thread", turnId: active.id, item },
    });
    complete();
    return;
  }
  if (text.startsWith("permission_")) {
    const requestId = `permission-${nextTurn}`;
    active.pending = { id: requestId, kind: "permission" };
    send({
      id: requestId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "fixture-thread",
        turnId: active.id,
        itemId: `command-${nextTurn}`,
        reason: "Allow fixture?",
        command: "fixture",
        cwd: "<fixture>",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });
    return;
  }
  if (text === "questions") {
    const requestId = `questions-${nextTurn}`;
    active.pending = { id: requestId, kind: "questions" };
    send({
      id: requestId,
      method: "item/tool/requestUserInput",
      params: {
        threadId: "fixture-thread",
        turnId: active.id,
        itemId: `question-${nextTurn}`,
        isBlocking: true,
        autoResolutionMs: null,
        questions: [
          {
            id: "q-single",
            header: "Single",
            question: "Single?",
            isOther: false,
            isSecret: false,
            options: [{ label: "yes", description: "Yes" }],
          },
          {
            id: "q-multi",
            header: "Multiple",
            question: "Multiple?",
            isOther: false,
            isSecret: false,
            multiple: true,
            options: [
              { label: "one", description: "One" },
              { label: "two", description: "Two" },
            ],
          },
          {
            id: "q-free",
            header: "Free",
            question: "Free?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });
    return;
  }
  if (text === "interrupt") return;
  if (text === "environment") {
    stream([process.env.HARNESS_CODEX_FIXTURE_SECRET ?? "missing-environment-value"]);
    return;
  }
  if (text === "stream") stream();
  else complete();
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "codex-fixture/0.147.0" } });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "account/read") {
    send({ id: message.id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: true } });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    send({
      id: message.id,
      result: { thread: { id: "fixture-thread", status: { type: "idle" }, turns: [] } },
    });
    return;
  }
  if (message.method === "turn/start") {
    const id = `fixture-turn-${++nextTurn}`;
    const text = message.params?.input?.[0]?.text ?? "";
    active = { id, text };
    send({ id: message.id, result: { turn: { id, status: "inProgress", items: [] } } });
    send({
      method: "turn/started",
      params: { threadId: "fixture-thread", turn: { id, status: "inProgress", items: [] } },
    });
    setTimeout(() => startScenario(text), 1);
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: active?.id } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    complete("interrupted");
    return;
  }
  if (message.id !== undefined && active?.pending?.id === message.id) {
    const pending = active.pending;
    active.pending = undefined;
    if (pending.kind === "permission" && message.result?.decision === "cancel")
      complete("interrupted");
    else complete();
  }
});

lines.on("close", () => process.exit(0));
