import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Redactor } from "./redaction.js";

export interface HarnessLogger {
  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ): void | Promise<void>;
  close?(): void | Promise<void>;
}

export class RotatingFileLogger implements HarnessLogger {
  readonly #directory: string;
  readonly #file: string;
  readonly #redactor: Redactor;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(homeDir: string, redactor: Redactor, maxBytes = 1_000_000, maxFiles = 3) {
    this.#directory = join(homeDir, "logs");
    this.#file = join(this.#directory, "harness.log");
    this.#redactor = redactor;
    this.#maxBytes = maxBytes;
    this.#maxFiles = maxFiles;
  }

  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: this.#redactor.text(message),
      ...(data ? { data: this.#redactor.value(data) } : {}),
    });
    this.#tail = this.#tail.then(async () => {
      await mkdir(this.#directory, { recursive: true });
      await this.#rotateIfNeeded(Buffer.byteLength(entry) + 1);
      await appendFile(this.#file, `${entry}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.#tail;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail;
  }

  async #rotateIfNeeded(incomingBytes: number): Promise<void> {
    let size = 0;
    try {
      size = (await stat(this.#file)).size;
    } catch {
      return;
    }
    if (size + incomingBytes <= this.#maxBytes) return;
    for (let index = this.#maxFiles - 1; index >= 1; index--) {
      try {
        await rename(`${this.#file}.${index}`, `${this.#file}.${index + 1}`);
      } catch {
        // Missing older log segments are expected.
      }
    }
    try {
      await rename(this.#file, `${this.#file}.1`);
    } catch {
      // Another process or cleanup may have removed it.
    }
  }
}
