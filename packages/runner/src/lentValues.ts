const minValueChars = 8;
const mask = "***";

// A value stays masked after a refresh; only expired Codex access and ID tokens go.
export class LentValues {
  // Longest first, so a value inside another value leaves no part of the longer one.
  private readonly entries: { name: string; value: string }[] = [];

  add(name: string, value: string) {
    if (value.length < minValueChars) {
      throw new Error(
        `${name} has fewer than ${minValueChars} characters, so the runner cannot mask it.`,
      );
    }
    if (this.entries.some((entry) => entry.value === value)) return;
    this.entries.push({ name, value });
    this.entries.sort((first, second) => second.value.length - first.value.length);
  }

  delete(value: string) {
    const index = this.entries.findIndex((entry) => entry.value === value);
    if (index !== -1) this.entries.splice(index, 1);
  }

  // The raw end to keep: it can start a lent value, and no whole value crosses its start.
  heldLength(text: string) {
    let cut = text.length;
    for (const { value } of this.entries) {
      for (let length = Math.min(value.length - 1, text.length); length > 0; length--) {
        if (text.endsWith(value.slice(0, length))) {
          cut = Math.min(cut, text.length - length);
          break;
        }
      }
    }
    let hasMoved = true;
    while (hasMoved) {
      hasMoved = false;
      for (const { value } of this.entries) {
        const from = Math.max(0, cut - value.length + 1);
        for (let start = text.indexOf(value, from); start !== -1 && start < cut;) {
          cut = start;
          hasMoved = true;
          start = text.indexOf(value, Math.max(0, cut - value.length + 1));
        }
      }
    }
    return text.length - cut;
  }

  find(text: string) {
    return this.entries.find(({ value }) => text.includes(value))?.name;
  }

  mask<T>(value: T): T {
    if (this.entries.length === 0) return value;
    return this.maskValue(value) as T;
  }

  private maskValue(value: unknown): unknown {
    if (typeof value === "string") return this.maskText(value);
    if (Array.isArray(value)) return value.map((item) => this.maskValue(item));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [this.maskText(key), this.maskValue(item)]),
    );
  }

  private maskText(text: string) {
    return this.entries.reduce((masked, { value }) => masked.replaceAll(value, mask), text);
  }
}
