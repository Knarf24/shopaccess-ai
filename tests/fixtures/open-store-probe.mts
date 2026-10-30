import { openFoundationStoreWithKeyFile } from "../../src/lib/session/snapshot-store";

// A disposable-store probe run as its own OS process by tests/unit/format10-end-to-end.test.tsx. It never writes.
// usage: --directory D --key-file K --mode ordinary|workload [--hold]
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1] ?? "";
const directory = value("--directory");
const keyFile = value("--key-file");
const workload = value("--mode") === "workload";
const opened = await openFoundationStoreWithKeyFile(directory, keyFile, workload ? { workloadRecords: true } : {});
const published = opened.status === "ready" ? opened.value.readPublished() : null;
const body = published && published.status === "ready" ? (published.value.body as unknown as Record<string, unknown>) : null;
process.stdout.write(
  `${JSON.stringify({
    open: opened.status === "ready" ? "ready" : opened.code,
    publishedFormat: published && published.status === "ready" ? published.value.format : null,
    legacyDrafts: body && Array.isArray(body.legacyDrafts) ? body.legacyDrafts.length : null,
    workloads: body && Array.isArray(body.workloads) ? body.workloads.length : null,
    pid: process.pid,
  })}\n`,
);
if (args.includes("--hold") && opened.status === "ready") {
  process.stdout.write("holding\n");
  setInterval(() => undefined, 1000);
} else if (opened.status === "ready") {
  await opened.value.close?.();
}
