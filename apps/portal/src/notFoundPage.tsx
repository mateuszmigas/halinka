import { Link } from "@tanstack/react-router";

import { Page } from "./page";

export const NotFoundPage = () => (
  <Page>
    <p className="text-muted-foreground">
      This page does not exist.{" "}
      <Link to="/runs" className="text-link hover:underline">
        Go to runs
      </Link>
    </p>
  </Page>
);
