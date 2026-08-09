#!/usr/bin/env node

import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { createClaudeProvider } from "@harness-sdk/claude";
import { createCodexProvider } from "@harness-sdk/codex";
import {
  createHarness,
  type HarnessEvent,
  type PermissionDecision,
  type Session,
  type SessionId,
} from "@harness-sdk/core";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function smoke(): Promise<void> {
  const homeDir = await mkdtemp(join(tmpdir(), "harness-tui-smoke-"));
  const harness = await createHarness({ homeDir, providers: {} });
  await harness.close();
  process.stdout.write("Harness TUI smoke test passed\n");
}

function renderEvent(event: HarnessEvent): void {
  switch (event.type) {
    case "message.delta":
      process.stdout.write(event.data.delta);
      break;
    case "message.completed":
      process.stdout.write("\n");
      break;
    case "tool.started":
      process.stdout.write(`\n[tool] ${event.data.name}\n`);
      break;
    case "diagnostic":
      process.stdout.write(`\n[${event.data.level}] ${event.data.message}\n`);
      break;
    default:
      break;
  }
}

function choosePermission(answer: string): PermissionDecision {
  answer = answer.trim().toLowerCase();
  if (answer === "a") return { decision: "allow_session" };
  if (answer === "c") return { decision: "cancel_turn", reason: "Cancelled in TUI" };
  if (answer === "y" || answer === "yes") return { decision: "allow_once" };
  return { decision: "deny", reason: "Denied in TUI" };
}

type UiInteraction =
  | { kind: "permission"; event: Extract<HarnessEvent, { type: "permission.requested" }> }
  | {
      kind: "input";
      event: Extract<HarnessEvent, { type: "input.requested" }>;
      questionIndex: number;
      answers: Record<string, string[]>;
    };

function interactionPrompt(interaction: UiInteraction): string {
  if (interaction.kind === "permission") {
    return `${interaction.event.data.title} [y]es/[a]lways/[n]o/[c]ancel: `;
  }
  const question = interaction.event.data.request.questions[interaction.questionIndex];
  if (!question) return "> ";
  const choices = question.options?.map((option) => option.label).join(", ");
  return `${question.prompt}${choices ? ` (${choices})` : ""}${question.multiple ? " [comma-separated]" : ""}: `;
}

async function printHistory(session: Session): Promise<void> {
  const snapshot = await session.snapshot();
  for (const message of snapshot.messages) {
    process.stdout.write(`${message.role}> ${message.text}\n`);
  }
}

async function run(): Promise<void> {
  if (process.argv.includes("--smoke")) return await smoke();
  const providerName = argument("--provider") ?? "codex";
  const homeDir = argument("--home") ?? join(homedir(), ".harness-sdk-example");
  const harness = await createHarness({
    homeDir,
    providers: {
      codex: createCodexProvider({
        ...(process.env.CODEX_EXECUTABLE ? { executable: process.env.CODEX_EXECUTABLE } : {}),
        environment: async () => ({ OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
      }),
      claude: createClaudeProvider({
        ...(process.env.CLAUDE_CODE_EXECUTABLE
          ? { executable: process.env.CLAUDE_CODE_EXECUTABLE }
          : {}),
      }),
    },
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let session: Session;
  const requestedSession = argument("--session");
  if (requestedSession) {
    session = await harness.sessions.load(requestedSession as SessionId);
  } else {
    const status = await harness.providers[providerName]?.status();
    if (!status || status.state !== "ready") {
      throw new Error(
        `${providerName} is ${status?.state ?? "not registered"}${status && "message" in status ? `: ${status.message}` : ""}`,
      );
    }
    session = await harness.sessions.create({ provider: providerName, cwd: process.cwd() });
  }

  await printHistory(session);
  const snapshot = await session.snapshot();
  const interactions: UiInteraction[] = [];
  const showPrompt = () => {
    process.stdout.write(interactions[0] ? interactionPrompt(interactions[0]) : "> ");
  };
  const subscription = await session.subscribe(
    { afterSequence: snapshot.sequence },
    {
      onEvent: (event) => {
        renderEvent(event);
        if (event.type === "permission.requested") {
          interactions.push({ kind: "permission", event });
          process.stdout.write(`\n${interactionPrompt(interactions[0]!)}`);
        } else if (event.type === "input.requested") {
          interactions.push({ kind: "input", event, questionIndex: 0, answers: {} });
          process.stdout.write(`\n${interactionPrompt(interactions[0]!)}`);
        } else if (event.type === "permission.resolved" || event.type === "input.resolved") {
          const index = interactions.findIndex(
            (interaction) => interaction.event.data.requestId === event.data.requestId,
          );
          if (index >= 0) interactions.splice(index, 1);
        }
      },
      onError: (error) => {
        process.stderr.write(`[subscription] ${error.message}\n`);
      },
    },
  );

  process.stdout.write(`Session ${session.id} (${session.provider})\n`);
  process.stdout.write("Commands: /interrupt, /history, /sessions, /quit\n");
  showPrompt();
  try {
    for await (const line of readline) {
      const input = line.trim();
      if (input === "/quit") break;
      if (input === "/interrupt") {
        await session.interrupt();
        showPrompt();
        continue;
      }
      const interaction = interactions[0];
      if (interaction?.kind === "permission") {
        interactions.shift();
        await session.respondToPermission(
          interaction.event.data.requestId,
          choosePermission(input),
        );
        showPrompt();
        continue;
      }
      if (interaction?.kind === "input") {
        const question = interaction.event.data.request.questions[interaction.questionIndex]!;
        interaction.answers[question.id] = question.multiple
          ? input
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : [input];
        interaction.questionIndex++;
        if (interaction.questionIndex === interaction.event.data.request.questions.length) {
          interactions.shift();
          await session.respondToInput(interaction.event.data.requestId, {
            answers: interaction.answers,
          });
        }
        showPrompt();
        continue;
      }
      if (!input) {
        showPrompt();
        continue;
      }
      if (input === "/history") {
        await printHistory(session);
        showPrompt();
        continue;
      }
      if (input === "/sessions") {
        for (const item of await harness.sessions.list({ includeArchived: true })) {
          process.stdout.write(`${item.id} ${item.provider} ${item.state} ${item.cwd}\n`);
        }
        showPrompt();
        continue;
      }
      const turn = await session.send({ text: input });
      void turn.done().then((result) => {
        process.stdout.write(`\n[turn ${turn.id}] ${result.status}\n`);
      });
      showPrompt();
    }
  } finally {
    await subscription.close();
    readline.close();
    await harness.close();
  }
}

await run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
