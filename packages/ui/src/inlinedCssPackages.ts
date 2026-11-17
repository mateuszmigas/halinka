import { join } from "node:path";

// Tailwind inlines the CSS that styles.css imports, so a bundle does not list the files of these packages.
export const inlinedCssPackages = ["tw-animate-css", "shadcn"].map((name) =>
  join(import.meta.dirname, "../node_modules", name, "package.json"),
);
