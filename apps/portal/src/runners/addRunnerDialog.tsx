import { Button } from "@halinka/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@halinka/ui/components/dialog";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { EnrollmentTokenButton } from "./enrollmentTokenButton";
import { settingsOf, settingsValuesOf } from "./runnerSettings";
import { AllowedAgentsField, LabelsField } from "./runnerSettingsFields";

const AddRunnerForm = () => {
  const [values, setValues] = useState(settingsValuesOf);
  const [isCreated, setIsCreated] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <LabelsField
        id="new-runner-labels"
        value={values.labels}
        onChange={(labels) => setValues({ ...values, labels })}
        issues={[]}
        disabled={isCreated}
      />
      <AllowedAgentsField
        id="new-runner-agents"
        value={values.allowedAgents}
        onChange={(allowedAgents) => setValues({ ...values, allowedAgents })}
        issues={[]}
        disabled={isCreated}
      />
      <EnrollmentTokenButton
        label="Create the command"
        target={settingsOf(values)}
        onCreated={() => setIsCreated(true)}
      />
    </div>
  );
};

export const AddRunnerDialog = () => (
  <Dialog disablePointerDismissal>
    <DialogTrigger render={<Button />}>
      <PlusIcon />
      Add runner
    </DialogTrigger>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Add runner</DialogTitle>
        <DialogDescription>
          Set the runner, then run the command on the machine. The machine joins with no approval.
        </DialogDescription>
      </DialogHeader>
      <AddRunnerForm />
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Done</DialogClose>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
