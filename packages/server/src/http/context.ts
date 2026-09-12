import type { Db } from '../db/connection.js';
import type { KeyRing } from '../config.js';

export interface AppContext {
  db: Db;
  ring: KeyRing;
  logLevel?: string;
  trustProxy?: boolean | number | string;
}
