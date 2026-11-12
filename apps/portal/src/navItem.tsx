import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@halinka/ui/components/sidebar";
import { Link, type LinkProps } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";

export type NavItemProps = {
  to: LinkProps["to"];
  icon: LucideIcon;
  label: string;
  isExact?: boolean;
  badge?: number;
};

export const NavItem = (props: NavItemProps) => {
  const { to, icon: Icon, label, isExact = false, badge } = props;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={label}
        render={
          <Link to={to} activeOptions={{ exact: isExact }} activeProps={{ "data-active": "" }} />
        }
      >
        <Icon />
        <span>{label}</span>
        {badge ? <SidebarMenuBadge>{badge}</SidebarMenuBadge> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
