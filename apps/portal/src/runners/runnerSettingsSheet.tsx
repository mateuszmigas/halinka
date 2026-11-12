import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@halinka/ui/components/sheet";

import { RunnerSettingsForm, type RunnerSettingsFormProps } from "./runnerSettingsForm";

export type RunnerSettingsSheetProps = {
  runner: (RunnerSettingsFormProps["runner"] & { name: string }) | undefined;
  isOpen: boolean;
  onClose: () => void;
};

export const RunnerSettingsSheet = (props: RunnerSettingsSheetProps) => {
  const { runner, isOpen, onClose } = props;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="data-[side=right]:sm:max-w-md">
        <SheetHeader className="border-b p-4">
          <SheetTitle>Edit runner</SheetTitle>
          <SheetDescription>{runner?.name}</SheetDescription>
        </SheetHeader>
        {runner && (
          <div className="flex-1 overflow-y-auto p-4">
            <RunnerSettingsForm runner={runner} onDone={onClose} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
};
