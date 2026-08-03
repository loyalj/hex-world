// Web Worker entry for off-main-thread chunk building. Deliberately tiny: all
// logic lives in ChunkWorkerProtocol.ts (testable without a Worker), and no
// module imported here may pull in `three` — the library build externalizes it,
// which would leave an unresolvable bare specifier inside the worker bundle.
import { createChunkWorkerHandler, type ChunkWorkerRequest } from './ChunkWorkerProtocol.js';

// Minimal structural typing for the dedicated-worker scope, so this file
// compiles under the project's DOM lib without pulling in lib.webworker
// (the two conflict when combined).
interface DedicatedWorkerScope {
  onmessage: ((event: { data: ChunkWorkerRequest }) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
}

const scope  = globalThis as unknown as DedicatedWorkerScope;
const handle = createChunkWorkerHandler();

scope.onmessage = (event) => {
  try {
    const { response, transfer } = handle(event.data);
    if (response) scope.postMessage(response, transfer);
  } catch (err) {
    const id = event.data.type === 'build' ? event.data.id : null;
    scope.postMessage({ type: 'error', id, message: String(err) });
  }
};
