import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@halinka/ui/components/alert-dialog";
import type { ReactNode } from "react";

export type Confirmation = { title: string; description: string; keepLabel: string };

export type ConfirmDialogProps = {
  confirm: Confirmation;
  actionLabel: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  onConfirm: () => void;
  trigger?: ReactNode;
};

export const ConfirmDialog = (props: ConfirmDialogProps) => {
  const { confirm, actionLabel, isOpen, onOpenChange, onConfirm, trigger } = props;

  return (
    <AlertDialog open={isOpen} onOpenChange={onOpenChange}>
      {trigger}
      <AlertDialogContent>
        <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
        <AlertDialogDescription>{confirm.description}</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>{confirm.keepLabel}</AlertDialogCancel>
          <AlertDialogCancel variant="destructive" onClick={onConfirm}>
            {actionLabel}
          </AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
