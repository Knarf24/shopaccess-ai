import { createHash } from "node:crypto";
import fs from "node:fs";

import { canonicalJson } from "../../src/lib/shared/canonical-json";
import { openFoundationStore } from "../../src/lib/session/snapshot-store";

const [mode, directory, keyFile] = process.argv.slice(2);
if (!mode || !directory || !keyFile) process.exit(2);

const key = fs.readFileSync(keyFile);

if (mode === "hold") {
  const opened = await openFoundationStore(directory, key);
  if (opened.status !== "ready") process.exit(1);
  fs.writeSync(3, Buffer.from([1]));
  await waitForRelease();
  process.exit(0);
}

if (mode === "contend") {
  const opened = await openFoundationStore(directory, key);
  process.stdout.write(opened.status === "unavailable" ? opened.code : "ready");
  process.exit(0);
}

if (mode === "reopen") {
  const opened = await openFoundationStore(directory, key);
  if (opened.status !== "ready") process.exit(1);
  const published = opened.value.readPublished();
  if (published.status !== "ready") process.exit(1);
  const hash = createHash("sha256").update(canonicalJson(published.value.body), "utf8").digest("hex");
  process.stdout.write(hash);
  process.exit(0);
}

if (mode === "uncertain") {
  const opened = await openFoundationStore(directory, key, {
    directoryFsync: async () => {
      throw new Error("directory-flush");
    },
  });
  if (opened.status !== "ready") process.exit(1);
  const published = opened.value.readPublished();
  if (published.status !== "ready") process.exit(1);
  const candidate = {
    allocation: { windowStartedAt: 1, count: 1 },
    admissionLogin: published.value.body.admissionLogin,
    sessions: published.value.body.sessions,
    drafts: published.value.body.drafts,
    conversations: published.value.body.conversations,
    selections: published.value.body.selections,
    grants: published.value.body.grants,
    permissions: published.value.body.permissions,
    profiles: published.value.body.profiles,
    profileRevisions: published.value.body.profileRevisions,
    chargerTracks: published.value.body.chargerTracks,
  };
  const committed = await opened.value.commit(candidate);
  if (committed.status !== "unavailable" || committed.outcome !== "indeterminate") process.exit(1);
  process.stdout.write(createHash("sha256").update(canonicalJson(candidate), "utf8").digest("hex"));
  process.exit(0);
}

if (mode === "failed-write") {
  const opened = await openFoundationStore(directory, key, {
    temporaryWrite: async () => {
      throw new Error("temporary-write");
    },
  });
  if (opened.status !== "ready") process.exit(1);
  const published = opened.value.readPublished();
  if (published.status !== "ready") process.exit(1);
  const failed = await opened.value.commit({
    allocation: { windowStartedAt: 2, count: 1 },
    admissionLogin: { windowStartedAt: null, count: 0 },
    sessions: [],
    drafts: [],
    conversations: [],
    selections: [],
    grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [],
  });
  if (failed.status !== "unavailable" || failed.outcome !== "definite") process.exit(1);
  process.stdout.write(createHash("sha256").update(canonicalJson(published.value.body), "utf8").digest("hex"));
  process.exit(0);
}

if (mode === "mismatch") {
  const opened = await openFoundationStore(directory, key, {
    beforePathRecheck: async () => {
      fs.writeSync(3, Buffer.from([1]));
      await waitForRelease();
    },
  });
  process.exit(opened.status === "unavailable" ? 0 : 1);
}

process.exit(2);

function waitForRelease(): Promise<void> {
  process.stdin.resume();
  return new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
  });
}
