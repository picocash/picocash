/**
 * KV over a directory of JSON files — the Node/container deployment's
 * equivalent of Workers KV. One file per key; writes are atomic (temp file +
 * rename) so a crash mid-write never leaves a half snapshot behind.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KvLike } from './store.js';

export class FileKv implements KvLike {
  private ready: Promise<void> | null = null;
  constructor(readonly dir: string) {}

  private path(key: string) {
    return join(this.dir, `${encodeURIComponent(key)}.json`);
  }
  private ensureDir() {
    return (this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined));
  }

  async get(key: string): Promise<string | null> {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(key: string, value: string): Promise<void> {
    await this.ensureDir();
    const target = this.path(key);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, value, 'utf8');
    await rename(tmp, target);
  }
}
