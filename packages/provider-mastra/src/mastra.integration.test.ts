import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MastraClient } from "@mastra/client-js";
import { createHarness, type Harness, type Session } from "@triadlabs/harness-sdk";
import { describe, expect, it } from "vitest";

import { createMastraProvider, MASTRA_PROVIDER_ID } from "./adapter.js";

const enabled = process.env.HARNESS_RUN_MASTRA_INTEGRATION === "1";

function assistantText(session: Session): Promise<string> {
  return session.snapshot().then(
    (snapshot) =>
      snapshot.messages
        .filter((message) => message.role === "assistant")
        .at(-1)
        ?.text.trim() ?? "",
  );
}

describe.skipIf(!enabled)("Mastra remote-provider integration", () => {
  it("streams and resumes remote memory after a Harness restart", async () => {
    const baseUrl = process.env.MASTRA_SERVER_URL?.trim();
    const agentId = process.env.MASTRA_AGENT_ID?.trim();
    if (!baseUrl || !agentId) {
      throw new Error(
        "MASTRA_SERVER_URL and MASTRA_AGENT_ID are required for the Mastra integration test",
      );
    }

    const authToken = process.env.MASTRA_AUTH_TOKEN?.trim();
    const temporary = await mkdtemp(join(tmpdir(), "harness-mastra-integration-"));
    const token = `HARNESS_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const resourceId = `harness-integration-${randomUUID()}`;
    const provider = () =>
      createMastraProvider({
        baseUrl,
        agentId,
        resourceId,
        ...(authToken ? { authToken } : {}),
      });
    const openHarness = (): Promise<Harness> =>
      createHarness({
        homeDir: temporary,
        providers: { [MASTRA_PROVIDER_ID]: provider() },
        rawEvents: "none",
        textDeltaCoalesceMs: 0,
      });

    let harness: Harness | undefined;
    let remoteThreadId: string | undefined;
    try {
      harness = await openHarness();
      await expect(harness.providers[MASTRA_PROVIDER_ID]!.status()).resolves.toMatchObject({
        state: "ready",
      });
      const session = await harness.sessions.create({ provider: MASTRA_PROVIDER_ID });
      remoteThreadId = session.id;
      await expect(
        (
          await session.send({
            text: `Remember ${token}. Reply with exactly TURN_ONE_OK.`,
          })
        ).done(),
      ).resolves.toEqual({ status: "completed" });
      expect(await assistantText(session)).toBe("TURN_ONE_OK");

      await harness.close();
      harness = await openHarness();
      const resumed = await harness.sessions.load(session.id);
      await expect(
        (
          await resumed.send({
            text: "Reply with exactly the token I asked you to remember.",
          })
        ).done(),
      ).resolves.toEqual({ status: "completed" });
      expect(await assistantText(resumed)).toBe(token);
    } finally {
      await harness?.close();
      if (remoteThreadId) {
        const cleanup = new MastraClient({
          baseUrl,
          retries: 0,
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        });
        await cleanup.deleteThread(remoteThreadId, { agentId });
      }
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
