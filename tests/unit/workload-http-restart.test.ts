import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../src/lib/session/cookie";
import { readConversation } from "../../src/lib/session/conversation";
import { workloadRecordForDraft } from "../../src/lib/session/workload-state";
import { parseTrustedOrigins } from "../../src/lib/session/request-guard";
import { recoverStateGate } from "../../src/lib/session/snapshot-state";
import { openFoundationStore } from "../../src/lib/session/snapshot-store";
import { needsDraftsFor } from "../../src/lib/session/store";
import { handleNeedsSession, handleNeedsSubmit } from "../../src/server/handlers";
import { createRuntime } from "../../src/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";

describe("format-9 HTTP workload recovery", () => {
  // About 23 sequential fsynced commits: about 1.2 s alone, but over the 5 s default when many files commit at once.
  it("persists an accepted laptop workload through truncation and a restart", { timeout: 30000 }, async () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "sa-workload-http-"));
    const reopenedDirectory = fs.mkdtempSync(join(tmpdir(), "sa-workload-http-reopen-"));
    const key = Buffer.from("isolated-format9-http-restart-key");
    const time = createTestClock();

    const storesToClose: Array<{ close?: () => Promise<void> }> = [];

    try {
      for (const path of [directory, reopenedDirectory]) {
        fs.chmodSync(path, 0o700);
      }

      const keyFile = join(directory, "identity.key");
      fs.writeFileSync(keyFile, key, { mode: 0o600 });

      const opened = await openFoundationStore(directory, key, {
        format9WorkloadTestStore: true,
        initializeEmpty: { keyFile },
      });
      expect(opened.status).toBe("ready");
      if (opened.status !== "ready") return;
        storesToClose.push(opened.value);

      const recovered = await recoverStateGate(opened.value, time.clock());
      expect(recovered.status).toBe("ready");
      if (recovered.status !== "ready") return;

      const config = {
        sessionKey: TEST_SESSION_KEY,
        trustedOrigins: parseTrustedOrigins([ORIGIN]),
      };

      const runtime = createRuntime(config, {
        clock: time.clock,
        gate: recovered.gate,
      });

      vi.spyOn(runtime.ai, "interpretNeeds").mockResolvedValue({
        understoodUse: "programming",
        budgetDollars: "900",
        followUp: null,
      });

      const sessionResponse = await handleNeedsSession(
        new Request(`${ORIGIN}/session/needs`),
        runtime,
      );
      expect(sessionResponse.status).toBe(303);

      const token = sessionResponse.headers.get("set-cookie")!
        .split(";")[0].split("=")[1];

      const resolved = await runtime.sessions.resolve(token);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;

      const buyer = {
        sessionId: resolved.value.id,
        csrfToken: resolved.value.csrfToken,
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      };

      const submit = async (shopperText: string) => {
        const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
        const fields: Record<string, string> = {
          lang: "en",
          shopperText,
          csrfToken: buyer.csrfToken,
        };

        if (draft) {
          fields.draftId = draft.draftId;
          fields.version = String(draft.version);
        }

        const response = await handleNeedsSubmit(
          new Request(`${ORIGIN}/shop/needs/submit`, {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              origin: ORIGIN,
              "sec-fetch-site": "same-origin",
              cookie: buyer.cookie,
            },
            body: new URLSearchParams(fields).toString(),
          }),
          runtime,
        );

        expect(response.status).toBe(303);
        return response;
      };

      await submit("I want to train AI models locally on my laptop, budget $900");

      for (let i = 0; i < 9; i++) {
        await submit(`Thank you, follow-up ${i + 1}`);
      }

      const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
      const turns = readConversation(runtime.store, buyer.sessionId)?.turns ?? [];

      expect(turns.some((turn) => turn.text.includes("train AI models locally"))).toBe(false);

      expect(workloadRecordForDraft(
        runtime.store, buyer.sessionId, draft.draftId, draft.version,
      )?.kind).toBe("local_training");

      const snapshot = opened.value.readPublished();
      expect(snapshot.status).toBe("ready");
      if (snapshot.status !== "ready") return;

      expect(snapshot.value.format).toBe(9);
      expect(snapshot.value.body.workloads?.some(
        (record) => record.sessionId === buyer.sessionId && record.kind === "local_training",
      )).toBe(true);

      fs.writeFileSync(
        join(reopenedDirectory, "store.json"),
        fs.readFileSync(join(directory, "store.json")),
        { mode: 0o600 },
      );

      const reopened = await openFoundationStore(reopenedDirectory, key, {
        format9WorkloadTestStore: true,
      });
      expect(reopened.status).toBe("ready");
      if (reopened.status !== "ready") return;
        storesToClose.push(reopened.value);

      const afterRestart = await recoverStateGate(reopened.value, time.clock());
      expect(afterRestart.status).toBe("ready");
      if (afterRestart.status !== "ready") return;

      const resumed = createRuntime(config, {
        clock: time.clock,
        gate: afterRestart.gate,
      });

      const resumedSession = await resumed.sessions.resolve(token);
      expect(resumedSession.ok).toBe(true);

      const resumedDraft = needsDraftsFor(resumed.store).get(buyer.sessionId)!;

      expect(resumedDraft.draftId).toBe(draft.draftId);
      expect(workloadRecordForDraft(
        resumed.store, buyer.sessionId, resumedDraft.draftId, resumedDraft.version,
      )?.kind).toBe("local_training");

      expect(
        readConversation(resumed.store, buyer.sessionId)?.turns.some(
          (turn) => turn.text.includes("train AI models locally"),
        ),
      ).toBe(false);
    } finally {
      try {
        for (const store of storesToClose.reverse()) {
          await store.close?.();
        }
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(reopenedDirectory, { recursive: true, force: true });
      }
    }
  });
});
