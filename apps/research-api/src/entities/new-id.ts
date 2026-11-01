import { v7 } from 'uuid';

/** Primary keys are time-ordered UUIDv7 strings, generated here rather than by the database. */
export const newId = (): string => v7();
