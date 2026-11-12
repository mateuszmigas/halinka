import { useSyncExternalStore } from "react";

import { ThemeStore } from "./themeStore";

export const themeStore = new ThemeStore(
  localStorage,
  window.matchMedia("(prefers-color-scheme: dark)"),
  document.documentElement,
);

export const useTheme = () => useSyncExternalStore(themeStore.subscribe, () => themeStore.theme);
