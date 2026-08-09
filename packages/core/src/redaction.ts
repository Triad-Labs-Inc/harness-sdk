const sensitiveKey = /(?:token|secret|password|authorization|credential|api[_-]?key|cookie)/i;
const bearer = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const commonSecret = /\b(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/g;

export class Redactor {
  #secrets = new Set<string>();

  register(values: readonly string[]): void {
    for (const value of values) {
      if (value.length >= 4) this.#secrets.add(value);
    }
  }

  value<T>(value: T, key = ""): T {
    return this.#redact(value, key, new WeakSet()) as T;
  }

  text(value: string): string {
    let redacted = value.replace(bearer, "Bearer <redacted>").replace(commonSecret, "<redacted>");
    for (const secret of this.#secrets) redacted = redacted.replaceAll(secret, "<redacted>");
    return redacted;
  }

  #redact(value: unknown, key: string, seen: WeakSet<object>): unknown {
    if (typeof value === "string") {
      if (sensitiveKey.test(key)) return "<redacted>";
      return this.text(value);
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "<circular>";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => this.#redact(item, key, seen));
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        sensitiveKey.test(childKey) ? "<redacted>" : this.#redact(child, childKey, seen),
      ]),
    );
  }
}
