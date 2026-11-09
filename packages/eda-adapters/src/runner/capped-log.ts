import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogCapture } from '@vcpu/research-core';

/** A log file that keeps the first `cap` bytes and counts the rest. */
export class CappedLog {
  private readonly fd: number;
  private bytes = 0;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly cap: number,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w');
  }

  write(chunk: Buffer): void {
    // A stream may still deliver after the runner gave up on it; its fd may belong to a new file.
    if (this.closed) return;
    const room = this.cap - this.bytes;
    this.bytes += chunk.length;
    if (room <= 0) return;
    try {
      writeSync(this.fd, chunk, 0, Math.min(room, chunk.length));
    } catch {
      // A full disk loses the rest of the log; the command's own result still stands.
    }
  }

  close(): LogCapture {
    if (this.closed)
      return { path: this.path, bytes: this.bytes, truncated: this.bytes > this.cap };
    this.closed = true;
    const truncated = this.bytes > this.cap;
    try {
      if (truncated) {
        writeSync(
          this.fd,
          `\n[log truncated: kept ${String(this.cap)} of ${String(this.bytes)} bytes]\n`,
        );
      }
    } finally {
      closeSync(this.fd);
    }
    return { path: this.path, bytes: this.bytes, truncated };
  }
}
