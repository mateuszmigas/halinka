import { useIsMobile } from "@halinka/ui/hooks/use-mobile";
import { useCanGoBack, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

export const useSwitchPane = () => {
  const router = useRouter();
  const { pane } = useSearch({ from: "/runs/$workflowRunId" });
  const navigate = useNavigate({ from: "/runs/$workflowRunId" });
  const isMobile = useIsMobile();
  const canGoBack = useCanGoBack();
  const isStepOpen = pane === "step";
  const stepListRef = useRef<HTMLDivElement>(null);
  const stepListButtonRef = useRef<HTMLButtonElement>(null);
  const wasStepOpen = useRef(isStepOpen);

  const openStep = () => {
    if (isMobile) void navigate({ search: { pane: "step" } });
  };
  const openStepList = () => {
    if (canGoBack) router.history.back();
    else void navigate({ search: {}, replace: true });
  };

  // The focused control of the pane that closes is hidden, so focus the pane that opens.
  useEffect(() => {
    if (wasStepOpen.current === isStepOpen) return;
    wasStepOpen.current = isStepOpen;
    if (isStepOpen) stepListButtonRef.current?.focus();
    else stepListRef.current?.querySelector<HTMLElement>('[aria-current="step"]')?.focus();
  }, [isStepOpen]);

  return { isStepOpen, openStep, openStepList, stepListRef, stepListButtonRef };
};
