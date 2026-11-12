import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@halinka/ui/components/breadcrumb";
import { Link, useMatches } from "@tanstack/react-router";
import { createContext, Fragment, useContext } from "react";
import { createPortal } from "react-dom";

export type Crumb = { label: string; path: string };

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    crumbs?: Crumb[];
  }
}

export const BreadcrumbSlotContext = createContext<HTMLElement | null>(null);

export type PageBreadcrumbProps = { parents?: Crumb[]; label: string };

export const PageBreadcrumb = (props: PageBreadcrumbProps) => {
  const { parents = [], label } = props;
  const slot = useContext(BreadcrumbSlotContext);
  const routeCrumbs = useMatches({
    select: (matches) => matches.flatMap((match) => match.staticData.crumbs ?? []),
  });

  if (slot === null) return null;

  return createPortal(
    <Breadcrumb>
      <BreadcrumbList>
        {[...routeCrumbs, ...parents].map((crumb) => (
          <Fragment key={crumb.path}>
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link to={crumb.path} />}>{crumb.label}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </Fragment>
        ))}
        <BreadcrumbItem>
          <BreadcrumbPage>{label}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>,
    slot,
  );
};
