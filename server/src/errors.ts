export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.name = 'ServiceError';
  }
}

export const QUEUE_ERROR_MESSAGES: Record<string, string> = {
  queue_empty: 'Nobody who has checked in is waiting.',
  nobody_serving: 'Nobody is being served right now.',
  not_found: 'That party is not in this event.',
  not_active: 'That party is not waiting in line.',
  not_missed: 'Only skipped or no-show parties can be put back in line.',
  already_there: 'That party is already there.',
};
