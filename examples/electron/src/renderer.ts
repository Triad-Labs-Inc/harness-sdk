import type { HarnessEvent, SessionId, SessionSnapshot } from "@triadlabs/harness";

import type {} from "./bridge.js";

const sessions = document.querySelector<HTMLSelectElement>("#sessions")!;
const providers = document.querySelector<HTMLSelectElement>("#providers")!;
const transcript = document.querySelector<HTMLPreElement>("#transcript")!;
const prompt = document.querySelector<HTMLInputElement>("#prompt")!;
let selected: SessionSnapshot | undefined;
let unsubscribe: () => void = () => undefined;

function append(text: string): void {
  transcript.textContent += text;
  transcript.scrollTop = transcript.scrollHeight;
}

async function selectSession(id: SessionId): Promise<void> {
  selected = await window.harness.snapshot(id);
  transcript.textContent = selected.messages
    .map((message) => `${message.role}> ${message.text}\n`)
    .join("");
  await window.harness.subscribe(id, selected.sequence);
}

async function handleInteraction(event: HarnessEvent): Promise<void> {
  if (!selected) return;
  if (event.type === "permission.requested") {
    const allowed = window.confirm(event.data.title);
    await window.harness.respondToPermission(selected.session.id, event.data.requestId, {
      decision: allowed ? "allow_once" : "deny",
      ...(allowed ? {} : { reason: "Denied in renderer" }),
    });
  } else if (event.type === "input.requested") {
    const answers: Record<string, string[]> = {};
    for (const question of event.data.request.questions) {
      const answer = window.prompt(question.prompt) ?? "";
      answers[question.id] = question.multiple
        ? answer.split(",").map((item) => item.trim())
        : [answer];
    }
    await window.harness.respondToInput(selected.session.id, event.data.requestId, { answers });
  }
}

const bootstrap = await window.harness.bootstrap();
for (const [name, status] of Object.entries(bootstrap.providers)) {
  const option = document.createElement("option");
  option.value = name;
  option.textContent = `${name} (${status.state})`;
  option.disabled = status.state !== "ready";
  providers.append(option);
}
for (const session of bootstrap.sessions) {
  const option = document.createElement("option");
  option.value = session.id;
  option.textContent = `${session.provider}: ${session.id}`;
  sessions.append(option);
}

unsubscribe = window.harness.onEvent((event) => {
  if (event.type === "message.delta") append(event.data.delta);
  if (event.type === "message.completed") append("\n");
  void handleInteraction(event);
});
window.addEventListener("beforeunload", () => unsubscribe());

sessions.addEventListener("change", () => void selectSession(sessions.value as SessionId));
document.querySelector("#create")!.addEventListener("click", async () => {
  selected = await window.harness.createSession(providers.value);
  const option = document.createElement("option");
  option.value = selected.session.id;
  option.textContent = `${selected.session.provider}: ${selected.session.id}`;
  sessions.append(option);
  sessions.value = selected.session.id;
  await selectSession(selected.session.id);
});
document.querySelector("#send")!.addEventListener("click", async () => {
  if (!selected || !prompt.value.trim()) return;
  await window.harness.send(selected.session.id, prompt.value);
  prompt.value = "";
});
document.querySelector("#interrupt")!.addEventListener("click", async () => {
  if (selected) await window.harness.interrupt(selected.session.id);
});

if (bootstrap.sessions[0]) {
  sessions.value = bootstrap.sessions[0].id;
  await selectSession(bootstrap.sessions[0].id);
}
