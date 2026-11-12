import { buttonVariants } from "@halinka/ui/components/button";

import { type SandboxAttach, vscodeAttachUrl } from "./vscodeAttachUrl";

export type OpenInVsCodeButtonProps = { attach: SandboxAttach };

export const OpenInVsCodeButton = (props: OpenInVsCodeButtonProps) => {
  const { attach } = props;

  return (
    <a
      className={buttonVariants({ variant: "outline" })}
      href={vscodeAttachUrl(attach)}
      title="Install the Dev Containers extension. Close the VS Code window before the run continues."
    >
      Open in VS Code
    </a>
  );
};
