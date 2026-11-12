import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@halinka/ui/components/sidebar";
import { TooltipProvider } from "@halinka/ui/components/tooltip";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useRouter } from "@tanstack/react-router";
import {
  BotIcon,
  CoinsIcon,
  FolderGit2Icon,
  GitBranchIcon,
  HomeIcon,
  ListChecksIcon,
  PlusIcon,
  ServerIcon,
  TerminalIcon,
  UsersIcon,
  WorkflowIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { api } from "./api";
import { BreadcrumbSlotContext } from "./breadcrumbs";
import { InboxLink } from "./inbox/inboxLink";
import { LoginPage } from "./login/loginPage";
import { useIsAdmin } from "./login/useIsAdmin";
import { MobileTabBar } from "./mobileTabBar";
import { NavItem } from "./navItem";
import { NewRunPopover } from "./runs/newRunPopover";
import { ScrollContainerContext } from "./scrollContainer";
import { UserMenu } from "./userMenu";

type NavGroupProps = { title?: string; children: ReactNode };

const NavGroup = (props: NavGroupProps) => {
  const { title, children } = props;

  return (
    <SidebarGroup>
      {title && <SidebarGroupLabel>{title}</SidebarGroupLabel>}
      <SidebarMenu>{children}</SidebarMenu>
    </SidebarGroup>
  );
};

// The sidebar component of shadcn writes this cookie at each fold.
const isSidebarFolded = () => document.cookie.includes("sidebar_state=false");

const CloseMobileSidebarOnNavigation = () => {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();

  useEffect(
    () => router.subscribe("onResolved", () => setOpenMobile(false)),
    [router, setOpenMobile],
  );

  return null;
};

export const Layout = () => {
  const { data: session, isPending } = useQuery(api.session.queryOptions());
  const isAdmin = useIsAdmin();
  const [breadcrumbSlot, setBreadcrumbSlot] = useState<HTMLElement | null>(null);
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);

  if (isPending) return null;
  if (session?.isLoginRequired && !session.user) return <LoginPage />;

  const loggedInUser = session?.isLoginRequired ? session.user : undefined;

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={!isSidebarFolded()} className="h-svh">
        <CloseMobileSidebarOnNavigation />
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <span className="truncate px-2 pt-1 text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              Halinka
            </span>
            <SidebarMenu>
              <SidebarMenuItem>
                <NewRunPopover
                  align="start"
                  trigger={
                    <SidebarMenuButton variant="outline" tooltip="New run">
                      <PlusIcon />
                      <span>New run</span>
                    </SidebarMenuButton>
                  }
                />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <nav aria-label="Main" className="flex flex-col">
              <NavGroup>
                <NavItem to="/" icon={HomeIcon} label="Home" isExact />
              </NavGroup>
              <NavGroup title="Work">
                <InboxLink />
                <NavItem to="/runs" icon={ListChecksIcon} label="Runs" />
                <NavItem to="/workflows" icon={WorkflowIcon} label="Workflows" />
              </NavGroup>
              <NavGroup title="Settings">
                <NavItem to="/repos" icon={FolderGit2Icon} label="Repos" />
                <NavItem to="/runners" icon={ServerIcon} label="Runners" />
                <NavItem to="/agents" icon={BotIcon} label="Agents" />
                {isAdmin && <NavItem to="/github" icon={GitBranchIcon} label="GitHub" />}
                {loggedInUser && <NavItem to="/terminals" icon={TerminalIcon} label="Terminals" />}
              </NavGroup>
              <NavGroup title="Team">
                <NavItem to="/costs" icon={CoinsIcon} label="Costs" />
                {session?.isLoginRequired && isAdmin && (
                  <NavItem to="/members" icon={UsersIcon} label="Members" />
                )}
              </NavGroup>
            </nav>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <UserMenu login={loggedInUser?.login} />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1 max-md:hidden" />
            <div ref={setBreadcrumbSlot} className="min-w-0" />
          </header>
          <div ref={setScrollContainer} className="min-h-0 flex-1 overflow-auto p-4 md:p-8">
            <BreadcrumbSlotContext value={breadcrumbSlot}>
              <ScrollContainerContext value={scrollContainer}>
                <Outlet />
              </ScrollContainerContext>
            </BreadcrumbSlotContext>
          </div>
          <MobileTabBar />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
};
