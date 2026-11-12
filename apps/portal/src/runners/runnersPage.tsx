import type { ApiOutputs } from "@halinka/server/client";
import { Badge } from "@halinka/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@halinka/ui/components/table";
import { buildLabelOf } from "@halinka/utils/buildLabel";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type ComponentProps, useState } from "react";

import { api } from "../api";
import { formatDateTime } from "../formatDateTime";
import { useIsAdmin } from "../login/useIsAdmin";
import { Page, PageHeader } from "../page";
import { Panel } from "../panel";
import { QueryFallback } from "../queryFallback";
import { RowMenu } from "../rowMenu";
import { statusPollMs } from "../statusPollMs";
import { useInvalidateQueries } from "../useInvalidateQueries";
import { AddRunnerDialog } from "./addRunnerDialog";
import { ApproveRunnerDialog } from "./approveRunnerDialog";
import { NewKeyDialog } from "./newKeyDialog";
import { RunnerSettingsSheet } from "./runnerSettingsSheet";
import { RunnerUpdate } from "./runnerUpdate";

type RunnerRow = ApiOutputs["runners"]["list"][number];

const statusOf = ({ state, isConnected }: RunnerRow) =>
  state === "active" ? (isConnected ? "online" : "offline") : state;

const statusVariant: Record<
  ReturnType<typeof statusOf>,
  ComponentProps<typeof Badge>["variant"]
> = {
  online: "success",
  offline: "secondary",
  draining: "warning",
  revoked: "destructive",
};

// Stays set after a close, so an overlay keeps its content while it closes.
type Expanded = { runnerId: number; part: "settings" | "key"; isOpen: boolean };

const buildStatusBadge: Record<
  NonNullable<RunnerRow["buildStatus"]>,
  { label: string; variant: ComponentProps<typeof Badge>["variant"] } | undefined
> = {
  current: undefined,
  outdated: { label: "out of date", variant: "warning" },
  update_needed: { label: "update needed", variant: "destructive" },
};

const RunnerVersion = (props: { runner: RunnerRow }) => {
  const { version, buildId, buildStatus } = props.runner;
  if (version === undefined || buildId === undefined) return null;
  const badge = buildStatus && buildStatusBadge[buildStatus];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="font-mono">{buildLabelOf(version, buildId)}</span>
        {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
      </div>
      <RunnerUpdate runner={props.runner} />
    </div>
  );
};

type RunnerActionsProps = { runner: RunnerRow; onExpand: (part: Expanded["part"]) => void };

const RunnerActions = (props: RunnerActionsProps) => {
  const { runner, onExpand } = props;
  const isAdmin = useIsAdmin();
  const onSuccess = useInvalidateQueries(api.runners.list.key());
  const update = useMutation(api.runners.update.mutationOptions({ onSuccess }));
  const revoke = useMutation(api.runners.revoke.mutationOptions({ onSuccess }));

  if (runner.state === "revoked" || !isAdmin) return null;

  return (
    <RowMenu
      name={runner.name}
      items={[
        { label: "Edit", onSelect: () => onExpand("settings") },
        { label: "New key", onSelect: () => onExpand("key") },
        {
          label: runner.state === "draining" ? "Resume" : "Drain",
          onSelect: () =>
            update.mutate({
              id: runner.id,
              state: runner.state === "draining" ? "active" : "draining",
            }),
        },
        {
          label: "Revoke",
          confirm: {
            title: `Revoke the runner ${runner.name}?`,
            description:
              "The server closes its connections and refuses its key. Its runs go back to the queue when their leases end. To use the machine again, register it as a new runner.",
            keepLabel: "Keep the runner",
          },
          onSelect: () => revoke.mutate({ id: runner.id }),
        },
      ]}
      isPending={update.isPending || revoke.isPending}
      error={update.error ?? revoke.error}
    />
  );
};

const RunnerList = () => {
  const runners = useQuery({ ...api.runners.list.queryOptions(), refetchInterval: statusPollMs });
  const [expanded, setExpanded] = useState<Expanded>();

  if (runners.data === undefined) return <QueryFallback error={runners.error} />;
  const expandedRunner = runners.data.find(({ id }) => id === expanded?.runnerId);
  const close = () => setExpanded(expanded && { ...expanded, isOpen: false });

  return (
    <Panel title="Runners" hasHeader={false}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Labels</TableHead>
            <TableHead>Allowed agents</TableHead>
            <TableHead>Machine</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Last seen</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {runners.data.map((runner) => {
            const status = statusOf(runner);
            return (
              <TableRow key={runner.id}>
                <TableCell data-cell="title" className="font-medium">
                  {runner.name}
                </TableCell>
                <TableCell data-cell="status">
                  <Badge variant={statusVariant[status]}>{status}</Badge>
                </TableCell>
                <TableCell data-cell="meta" data-label="Labels" className="font-mono">
                  {runner.labels.join(", ")}
                </TableCell>
                <TableCell data-cell="meta" data-label="Allowed agents">
                  {runner.allowedAgents?.join(", ") ?? "every agent"}
                </TableCell>
                <TableCell data-cell="meta">
                  {runner.os && `${runner.os} ${runner.arch ?? ""}`}
                </TableCell>
                <TableCell data-cell="meta" data-label="Version">
                  <RunnerVersion runner={runner} />
                </TableCell>
                <TableCell data-cell="meta" data-label="Last seen">
                  {runner.lastSeenAt && formatDateTime(runner.lastSeenAt)}
                </TableCell>
                <TableCell data-cell="menu">
                  <RunnerActions
                    runner={runner}
                    onExpand={(part) => setExpanded({ runnerId: runner.id, part, isOpen: true })}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <RunnerSettingsSheet
        runner={expanded?.part === "settings" ? expandedRunner : undefined}
        isOpen={expanded?.part === "settings" && expanded.isOpen && expandedRunner !== undefined}
        onClose={close}
      />
      <NewKeyDialog
        runner={expanded?.part === "key" ? expandedRunner : undefined}
        isOpen={expanded?.part === "key" && expanded.isOpen && expandedRunner !== undefined}
        onClose={close}
      />
    </Panel>
  );
};

export const RunnersPage = () => {
  const isAdmin = useIsAdmin();
  const { approve } = useSearch({ from: "/runners" });
  const navigate = useNavigate();

  return (
    <Page>
      <PageHeader
        title="Runners"
        description="The machines that execute runs."
        actions={
          isAdmin && (
            <div className="flex gap-2">
              <ApproveRunnerDialog
                code={approve}
                onCodeChange={(code) =>
                  void navigate({
                    to: "/runners",
                    search: code === undefined ? {} : { approve: code },
                    replace: true,
                  })
                }
              />
              <AddRunnerDialog />
            </div>
          )
        }
      />
      {!isAdmin && approve !== undefined && (
        <p className="text-muted-foreground">
          Only an Admin can approve a runner. Send the link to an Admin.
        </p>
      )}
      <RunnerList />
    </Page>
  );
};
