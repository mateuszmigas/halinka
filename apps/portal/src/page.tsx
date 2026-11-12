import type { ReactNode } from "react";

import { type Crumb, PageBreadcrumb } from "./breadcrumbs";

export type PageProps = { children: ReactNode };

export const Page = (props: PageProps) => {
  const { children } = props;

  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">{children}</div>;
};

export type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  crumbLabel?: string;
  parentCrumbs?: Crumb[];
};

export const PageHeader = (props: PageHeaderProps) => {
  const { title, description, actions, parentCrumbs } = props;
  const crumbLabel = props.crumbLabel ?? (typeof title === "string" ? title : undefined);

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {title}
        </h1>
        {description && <p className="max-w-3xl text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      {crumbLabel !== undefined && <PageBreadcrumb parents={parentCrumbs} label={crumbLabel} />}
    </header>
  );
};
