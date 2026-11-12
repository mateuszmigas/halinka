import type { ReactElement } from "react";

import { FormPopover } from "../formPopover";
import { CreateRunForm } from "./createRunForm";

export type NewRunPopoverProps = { trigger?: ReactElement; align?: "start" | "end" };

export const NewRunPopover = (props: NewRunPopoverProps) => {
  const { trigger, align } = props;

  return (
    <FormPopover label="New run" title="New run" width="md" trigger={trigger} align={align}>
      {(close) => <CreateRunForm onCreated={close} />}
    </FormPopover>
  );
};
