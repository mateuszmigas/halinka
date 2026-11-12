import { Button } from "@halinka/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@halinka/ui/components/dropdown-menu";
import { EllipsisIcon } from "lucide-react";
import { useState } from "react";

import { type Confirmation, ConfirmDialog } from "./confirmDialog";
import { ErrorText } from "./errorText";

export type RowMenuItem = { label: string; confirm?: Confirmation; onSelect: () => void };

export type RowMenuProps = {
  name: string;
  items: RowMenuItem[];
  isPending?: boolean;
  error?: Error | null;
};

export const RowMenu = (props: RowMenuProps) => {
  const { name, items, isPending = false, error = null } = props;
  // Stays set after a close, so the closing dialog keeps its text.
  const [confirmItem, setConfirmItem] = useState<RowMenuItem>();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  return (
    <div className="flex items-center justify-end gap-2 max-md:flex-col-reverse max-md:items-end">
      <ErrorText error={error} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`} />}
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          {items.map((item) => (
            <DropdownMenuItem
              key={item.label}
              variant={item.confirm ? "destructive" : "default"}
              disabled={isPending}
              onClick={
                item.confirm
                  ? () => {
                      setConfirmItem(item);
                      setIsConfirmOpen(true);
                    }
                  : item.onSelect
              }
            >
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmItem?.confirm && (
        <ConfirmDialog
          confirm={confirmItem.confirm}
          actionLabel={confirmItem.label}
          isOpen={isConfirmOpen}
          onOpenChange={setIsConfirmOpen}
          onConfirm={confirmItem.onSelect}
        />
      )}
    </div>
  );
};
