import { Button } from "@halinka/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@halinka/ui/components/dialog";

import { EnrollmentTokenButton } from "./enrollmentTokenButton";

export type NewKeyDialogProps = {
  runner: { id: number; name: string } | undefined;
  isOpen: boolean;
  onClose: () => void;
};

export const NewKeyDialog = (props: NewKeyDialogProps) => {
  const { runner, isOpen, onClose } = props;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()} disablePointerDismissal>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New key for {runner?.name}</DialogTitle>
          <DialogDescription>
            For a machine that lost its runner.json. The new key replaces the current key when the
            runner first connects with it.
          </DialogDescription>
        </DialogHeader>
        {runner && (
          <EnrollmentTokenButton label="Create a token" target={{ runnerId: runner.id }} />
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
