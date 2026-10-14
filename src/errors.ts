export class KaitenError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'KaitenError';
  }
}

// Never surface fetch/parser exception messages: they can contain signed URLs or credentials.
export function publicError(error: unknown): { code: string; message: string; status?: number } {
  if (error instanceof KaitenError) return { code: error.code, message: error.message, status: error.status };
  return { code: 'READ_FAILED', message: 'Unable to read the requested data. Check the format, connection and configuration.' };
}
