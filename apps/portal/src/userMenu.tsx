import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@halinka/ui/components/dropdown-menu";
import { SidebarMenuButton, useSidebar } from "@halinka/ui/components/sidebar";
import { LogOutIcon, MonitorIcon, MoonIcon, SunIcon, SunMoonIcon } from "lucide-react";

import { GitHubAvatar } from "./gitHubAvatar";
import { logOut } from "./login/session";
import { themeStore, useTheme } from "./theme";
import type { Theme } from "./themeStore";

const themes: { theme: Theme; label: string; icon: typeof SunIcon }[] = [
  { theme: "light", label: "Light", icon: SunIcon },
  { theme: "dark", label: "Dark", icon: MoonIcon },
  { theme: "system", label: "System", icon: MonitorIcon },
];

export type UserMenuProps = { login?: string };

export const UserMenu = (props: UserMenuProps) => {
  const { login } = props;
  const currentTheme = useTheme();
  const { isMobile } = useSidebar();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<SidebarMenuButton tooltip={login ?? "Theme"} />}>
        {login === undefined ? <SunMoonIcon /> : <GitHubAvatar login={login} className="size-5" />}
        <span>{login ?? "Theme"}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={isMobile ? "top" : "right"} align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={currentTheme}
            onValueChange={(theme: Theme) => themeStore.setTheme(theme)}
          >
            {themes.map(({ theme, label, icon: Icon }) => (
              <DropdownMenuRadioItem key={theme} value={theme}>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {login !== undefined && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void logOut()}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
