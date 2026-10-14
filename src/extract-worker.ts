import { parentPort, workerData } from 'node:worker_threads';
import { extract } from './extract.js';
import { publicError } from './errors.js';

try {
  const result = await extract(Buffer.from(workerData.bytes), workerData.name, workerData.maxChars, workerData.options);
  parentPort!.postMessage({ result });
} catch (error) {
  const safe = publicError(error);
  parentPort!.postMessage({ error: safe.code === 'READ_FAILED' ? { code: 'PARSE_FAILED', message: 'Unable to extract this file. It may be damaged, encrypted or unsupported. Read the original resource.' } : safe });
}
