import { Button } from "@halinka/ui/components/button";
import { newDevcontainerPath } from "@halinka/workflow";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api";
import { toFormErrors } from "../formErrors";
import { SelectField } from "../formFields";
import { FormIssues } from "../formIssues";

export type InitRepoPanelProps = {
  runnerId: number;
  path: string;
  // the devcontainer.json files of the folder, by path from its root
  devcontainers: string[];
  onDone: () => void;
};

const none = "none";

export const InitRepoPanel = (props: InitRepoPanelProps) => {
  const { runnerId, path, devcontainers, onDone } = props;
  const [choice, setChoice] = useState<string>();
  // Callbacks of `mutate` do not run after the panel closes, so a late answer keeps newer input.
  const init = useMutation(api.repos.init.mutationOptions());

  const options = [
    ...devcontainers.map((devcontainer) => ({ value: devcontainer, label: devcontainer })),
    ...(devcontainers.includes(newDevcontainerPath)
      ? []
      : [{ value: newDevcontainerPath, label: `Create ${newDevcontainerPath}` }]),
    { value: none, label: "None: workflows run only in worktrees" },
  ];
  const selected = choice ?? options[0]!.value;

  return (
    <div className="flex max-w-xl flex-col gap-3 rounded-lg border border-border p-3">
      <p>
        "Init and register" writes the files of halinka init to {path}, then registers the repo.
      </p>
      <SelectField
        id="devcontainer"
        label="Devcontainer"
        placeholder="Select a devcontainer"
        value={selected}
        onChange={setChoice}
        options={options}
        disabled={init.isPending}
        issues={[]}
      />
      <Button
        className="self-start"
        disabled={init.isPending}
        onClick={() =>
          init.mutate(
            { runnerId, path, devcontainer: selected === none ? undefined : selected },
            { onSuccess: onDone },
          )
        }
      >
        Init and register
      </Button>
      <FormIssues issues={init.error ? toFormErrors(init.error, []).form : []} />
    </div>
  );
};
