import { useSyncExternalStore } from "react";

let mobileQuery: MediaQueryList | undefined;
// The `md` breakpoint of Tailwind, so that the sidebar CSS and this hook agree at a fractional width.
const getMobileQuery = () => (mobileQuery ??= window.matchMedia("(width < 48rem)"));

const subscribe = (onChange: () => void) => {
  getMobileQuery().addEventListener("change", onChange);
  return () => getMobileQuery().removeEventListener("change", onChange);
};

const getSnapshot = () => getMobileQuery().matches;

export const useIsMobile = () => useSyncExternalStore(subscribe, getSnapshot);
