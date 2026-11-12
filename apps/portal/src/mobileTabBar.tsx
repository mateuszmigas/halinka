import { Badge } from "@halinka/ui/components/badge";
import { useSidebar } from "@halinka/ui/components/sidebar";
import { Link } from "@tanstack/react-router";
import { HomeIcon, InboxIcon, ListChecksIcon, MenuIcon } from "lucide-react";

import { usePendingInboxCount } from "./inbox/usePendingInboxCount";
import type { NavItemProps } from "./navItem";

const tabClassName =
  "relative flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[0.6875rem] text-muted-foreground data-active:text-foreground";

const TabLink = (props: NavItemProps) => {
  const { to, icon: Icon, label, isExact = false, badge } = props;

  return (
    <Link
      to={to}
      activeOptions={{ exact: isExact }}
      activeProps={{ "data-active": "" }}
      className={tabClassName}
    >
      <Icon className="size-5" />
      {label}
      {badge ? (
        <Badge className="absolute top-0.5 left-1/2 ml-1.5 h-auto px-1">{badge}</Badge>
      ) : null}
    </Link>
  );
};

const TabBar = () => {
  const { setOpenMobile } = useSidebar();
  const pendingInboxCount = usePendingInboxCount();

  return (
    <nav aria-label="Tab bar" className="flex shrink-0 border-t bg-background">
      <TabLink to="/" icon={HomeIcon} label="Home" isExact />
      <TabLink to="/inbox" icon={InboxIcon} label="Inbox" badge={pendingInboxCount} />
      <TabLink to="/runs" icon={ListChecksIcon} label="Runs" />
      <button type="button" className={tabClassName} onClick={() => setOpenMobile(true)}>
        <MenuIcon className="size-5" />
        Menu
      </button>
    </nav>
  );
};

export const MobileTabBar = () => (useSidebar().isMobile ? <TabBar /> : null);
