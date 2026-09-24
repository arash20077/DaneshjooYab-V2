/**
 * PLATFORM-MANAGED FILE — DO NOT EDIT OR DELETE.
 * The platform overwrites this file on every run; local changes are lost.
 *
 * SQLite database shared by all server code. Import it from server code as:
 *   import { db, migrate } from './lib/db.js';
 */
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'server', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA foreign_keys = ON;');
export function migrate(schemaSql: string): void { db.exec(schemaSql); }
