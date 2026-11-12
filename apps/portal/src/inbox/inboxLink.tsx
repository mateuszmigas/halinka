import { InboxIcon } from "lucide-react";

import { NavItem } from "../navItem";
import { usePendingInboxCount } from "./usePendingInboxCount";

export const InboxLink = () => (
  <NavItem to="/inbox" icon={InboxIcon} label="Inbox" badge={usePendingInboxCount()} />
);
