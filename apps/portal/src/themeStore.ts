export type Theme = "light" | "dark" | "system";

export type ThemeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SystemDarkQuery = {
  matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
};

export type ThemeRoot = { classList: Pick<DOMTokenList, "toggle"> };

// index.html reads the same key before the first paint.
export const themeStorageKey = "halinka.theme";

const readTheme = (storage: ThemeStorage): Theme => {
  try {
    const stored = storage.getItem(themeStorageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
};

export class ThemeStore {
  #theme: Theme;
  #listeners = new Set<() => void>();
  #storage: ThemeStorage;
  #systemDark: SystemDarkQuery;
  #root: ThemeRoot;

  constructor(storage: ThemeStorage, systemDark: SystemDarkQuery, root: ThemeRoot) {
    this.#storage = storage;
    this.#systemDark = systemDark;
    this.#root = root;
    this.#theme = readTheme(storage);
    systemDark.addEventListener("change", () => this.#apply());
    this.#apply();
  }

  get theme() {
    return this.#theme;
  }

  get isDark() {
    return this.#theme === "dark" || (this.#theme === "system" && this.#systemDark.matches);
  }

  setTheme(theme: Theme) {
    this.#theme = theme;
    try {
      if (theme === "system") this.#storage.removeItem(themeStorageKey);
      else this.#storage.setItem(themeStorageKey, theme);
    } catch {
      // Blocked storage keeps the theme for this page only.
    }
    this.#apply();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #apply() {
    this.#root.classList.toggle("dark", this.isDark);
    for (const listener of this.#listeners) listener();
  }
}
