import { Worker } from 'node:worker_threads';
import type { Extracted, ReadOptions } from './extract.js';
import { KaitenError } from './errors.js';

export async function readAttachment(bytes: Buffer, name: string, maxChars: number, options: ReadOptions): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./extract-worker.js', import.meta.url), {
      workerData: { bytes, name, maxChars, options },
      resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true,
    });
    // Parser/library logging must never enter the stdio protocol or expose signed URLs.
    worker.stdout?.resume(); worker.stderr?.resume();
    let settled = false;
    const timer = setTimeout(() => {
      settled = true; void worker.terminate();
      reject(new KaitenError('PARSE_TIMEOUT', 'File extraction exceeded 30 seconds. Read the original resource instead.'));
    }, 30_000);
    worker.once('message', message => {
      settled = true; clearTimeout(timer); void worker.terminate();
      if (message.error) reject(new KaitenError(message.error.code, message.error.message));
      else resolve(message.result);
    });
    worker.once('error', () => {
      settled = true; clearTimeout(timer);
      reject(new KaitenError('PARSE_FAILED', 'File extraction failed or exceeded memory limits.'));
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      if (!settled) reject(new KaitenError('PARSE_FAILED', 'File extraction ended unexpectedly.'));
    });
  });
}
