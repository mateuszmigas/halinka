import { buttonVariants } from "@halinka/ui/components/button";

export const App = () => (
  <main>
    <h1>Halinka</h1>
    <a className={buttonVariants()} href="https://github.com/mateuszmigas/halinka">
      View on GitHub
    </a>
  </main>
);
