import { v7 } from 'uuid';

/** UUIDv7: globally unique (safe to merge shops into one cloud DB) and time-ordered (index friendly). */
export const newId = (): string => v7();
