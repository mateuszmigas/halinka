import { Button } from "@halinka/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@halinka/ui/components/popover";
import { type ComponentProps, type ReactElement, type ReactNode, useState } from "react";

type ButtonProps = ComponentProps<typeof Button>;

export type FormPopoverProps = {
  label: string;
  icon?: ReactNode;
  ariaLabel?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  title: string;
  description?: string;
  width?: "sm" | "md" | "lg";
  align?: "start" | "end";
  // Replaces the button; label, variant, size and ariaLabel are then ignored.
  trigger?: ReactElement;
  // The popover holds its own state when the caller does not set them.
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
  children: (close: () => void) => ReactNode;
};

const widths = { sm: "w-80", md: "w-96", lg: "w-[40rem]" };

export const FormPopover = (props: FormPopoverProps) => {
  const {
    label,
    icon,
    ariaLabel,
    variant,
    size,
    title,
    description,
    width = "sm",
    align = "end",
    trigger,
    children,
  } = props;
  const [ownIsOpen, setOwnIsOpen] = useState(false);
  const isOpen = props.isOpen ?? ownIsOpen;
  const setIsOpen = props.onOpenChange ?? setOwnIsOpen;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      {trigger ? (
        <PopoverTrigger render={trigger} />
      ) : (
        <PopoverTrigger render={<Button variant={variant} size={size} aria-label={ariaLabel} />}>
          {icon}
          {label}
        </PopoverTrigger>
      )}
      <PopoverContent
        align={align}
        className={`${widths[width]} max-h-(--available-height) max-w-[calc(100vw-2rem)] overflow-y-auto`}
      >
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
          {description && <PopoverDescription>{description}</PopoverDescription>}
        </PopoverHeader>
        {children(() => setIsOpen(false))}
      </PopoverContent>
    </Popover>
  );
};
