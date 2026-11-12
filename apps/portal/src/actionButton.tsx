import { AlertDialogTrigger } from "@halinka/ui/components/alert-dialog";
import { Button } from "@halinka/ui/components/button";
import { type ComponentProps, type ReactNode, useState } from "react";

import { type Confirmation, ConfirmDialog } from "./confirmDialog";
import { ErrorText } from "./errorText";

export type ActionButtonProps = {
  label: string;
  icon?: ReactNode;
  pendingLabel?: string;
  size?: ComponentProps<typeof Button>["size"];
  confirm?: Confirmation;
  isPending: boolean;
  error: Error | null;
  onClick: () => void;
};

export const ActionButton = (props: ActionButtonProps) => {
  const { label, icon, pendingLabel = label, size, confirm, isPending, error, onClick } = props;
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const text = isPending ? pendingLabel : label;

  return (
    <div className="flex items-center gap-2">
      <ErrorText error={error} />
      {confirm ? (
        <ConfirmDialog
          confirm={confirm}
          actionLabel={label}
          isOpen={isConfirmOpen}
          onOpenChange={setIsConfirmOpen}
          onConfirm={onClick}
          trigger={
            <AlertDialogTrigger
              render={
                <Button
                  variant="outline"
                  size={size}
                  className="text-destructive"
                  disabled={isPending}
                />
              }
            >
              {icon}
              {text}
            </AlertDialogTrigger>
          }
        />
      ) : (
        <Button variant="outline" size={size} disabled={isPending} onClick={onClick}>
          {icon}
          {text}
        </Button>
      )}
    </div>
  );
};
