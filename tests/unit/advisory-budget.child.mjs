import { parentPort, workerData } from "node:worker_threads";
import { createBudgetedAdvisoryTransport } from "../../src/server/advisory-budget.ts";

const transport = createBudgetedAdvisoryTransport(workerData.directory, async () => ({
  status: 204,
  redirected: false,
  headers: { get() { return null; } },
  body: null,
}));
const request = {
  url: "https://synthorai.io/v1/chat/completions",
  method: "POST",
  headers: {},
  body: new Uint8Array(),
  signal: new AbortController().signal,
};

try {
  await transport(request);
  parentPort.postMessage("forwarded");
} catch {
  parentPort.postMessage("refused");
}
