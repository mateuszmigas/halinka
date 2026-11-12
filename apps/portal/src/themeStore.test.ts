import { describe, expect, it } from "vitest";

import { FakeBlockedStorage, FakeStorage, FakeSystemDarkQuery, FakeThemeRoot } from "./testing";
import { type ThemeStorage, ThemeStore, themeStorageKey } from "./themeStore";

type SetUpOptions = { isSystemDark?: boolean; storage?: ThemeStorage };

const setUp = ({ isSystemDark = false, storage = new FakeStorage() }: SetUpOptions = {}) => {
  const system = new FakeSystemDarkQuery(isSystemDark);
  const root = new FakeThemeRoot();
  const store = new ThemeStore(storage, system, root);
  return { storage, system, root, store, isDark: () => root.classes.has("dark") };
};

describe("ThemeStore", () => {
  it("follows the system when no theme is stored", () => {
    const { system, isDark } = setUp({ isSystemDark: true });

    system.change(false);

    expect(isDark()).toBe(false);
  });

  it("keeps a chosen theme when the system changes", () => {
    const { store, system, isDark } = setUp();
    store.setTheme("dark");

    system.change(false);

    expect(isDark()).toBe(true);
  });

  it("gives the stored theme to the next page", () => {
    const { store, storage } = setUp();

    store.setTheme("dark");

    expect(setUp({ storage }).store.theme).toBe("dark");
  });

  it("removes the stored theme when the person selects system", () => {
    const { store, storage } = setUp();
    store.setTheme("light");

    store.setTheme("system");

    expect(storage.getItem(themeStorageKey)).toBeNull();
  });

  it("treats an unknown stored value as system", () => {
    const storage = new FakeStorage();
    storage.setItem(themeStorageKey, "blue");

    expect(setUp({ storage }).store.theme).toBe("system");
  });

  it("changes the theme of the page when the storage is blocked", () => {
    const { store, isDark } = setUp({ storage: new FakeBlockedStorage() });

    store.setTheme("dark");

    expect(isDark()).toBe(true);
  });

  it("tells the subscribers when the person selects a theme", () => {
    const { store } = setUp();
    let calls = 0;
    store.subscribe(() => calls++);

    store.setTheme("dark");

    expect(calls).toBe(1);
  });

  it("tells the subscribers when the system theme changes", () => {
    const { store, system } = setUp();
    let calls = 0;
    store.subscribe(() => calls++);

    system.change(true);

    expect(calls).toBe(1);
  });
});
