import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@halinka/ui/components/alert-dialog";
import { Button } from "@halinka/ui/components/button";
import { Undo2Icon } from "lucide-react";
import { useState } from "react";

import { MessageForm } from "./messageForm";

export type ReopenStepButtonProps = {
  workflowRunId: number;
  stepRunId: number;
  stepId: string;
  onReopened: () => void;
};

export const ReopenStepButton = (props: ReopenStepButtonProps) => {
  const { workflowRunId, stepRunId, stepId, onReopened } = props;
  const [isOpen, setIsOpen] = useState(false);

  return (
    <AlertDialog open={isOpen} onOpenChange={setIsOpen}>
      <AlertDialogTrigger render={<Button variant="outline" />}>
        <Undo2Icon />
        Reopen
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>Reopen the step {stepId}?</AlertDialogTitle>
        <AlertDialogDescription>
          The run goes back to this step, and the agent gets your message. The later steps run
          again, and their changes leave the branch.
        </AlertDialogDescription>
        <MessageForm
          workflowRunId={workflowRunId}
          stepRunId={stepRunId}
          submitLabel="Reopen"
          onSent={() => {
            setIsOpen(false);
            onReopened();
          }}
        >
          <AlertDialogCancel>Keep the run</AlertDialogCancel>
        </MessageForm>
      </AlertDialogContent>
    </AlertDialog>
  );
};
