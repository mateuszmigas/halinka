import type { SystemDarkQuery, ThemeRoot } from "./themeStore";

type StorageArea = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export class FakeStorage implements StorageArea {
  #items = new Map<string, string>();
  isFull = false;

  getItem(key: string) {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.isFull) throw new Error("quota");
    this.#items.set(key, value);
  }

  removeItem(key: string) {
    this.#items.delete(key);
  }
}

// The storage of a browser that blocks site data.
export class FakeBlockedStorage implements StorageArea {
  getItem(): string | null {
    throw new Error("blocked");
  }

  setItem() {
    throw new Error("blocked");
  }

  removeItem() {
    throw new Error("blocked");
  }
}

export class FakeSystemDarkQuery implements SystemDarkQuery {
  #listeners: (() => void)[] = [];

  constructor(public matches: boolean) {}

  addEventListener(_type: "change", listener: () => void) {
    this.#listeners.push(listener);
  }

  change(matches: boolean) {
    this.matches = matches;
    for (const listener of this.#listeners) listener();
  }
}

export class FakeThemeRoot implements ThemeRoot {
  readonly classes = new Set<string>();

  readonly classList = {
    toggle: (name: string, force?: boolean) => {
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return this.classes.has(name);
    },
  };
}
