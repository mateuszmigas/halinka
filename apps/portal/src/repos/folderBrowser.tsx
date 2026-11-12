import { Button } from "@halinka/ui/components/button";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "../api";
import { QueryFallback } from "../queryFallback";

export type FolderBrowserProps = {
  runnerId: number;
  // undefined: the home folder of the runner user
  start: string | undefined;
  onSelect: (path: string) => void;
};

export const FolderBrowser = (props: FolderBrowserProps) => {
  const { runnerId, start, onSelect } = props;
  const [path, setPath] = useState(start);
  // A listing does not change while a person browses.
  const { data, error, isPlaceholderData, refetch } = useQuery({
    ...api.runners.folders.queryOptions({ input: { id: runnerId, path } }),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  return (
    <div className="flex max-w-xl flex-col gap-2 rounded-lg border border-border p-3">
      {!data && (
        <div className="flex items-center justify-between gap-2">
          <QueryFallback error={error} />
          {error && (
            <Button
              variant="outline"
              onClick={() => (path === undefined ? void refetch() : setPath(undefined))}
            >
              Open the home folder
            </Button>
          )}
        </div>
      )}
      {data && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono">{data.path}</span>
            <Button onClick={() => onSelect(data.path)} disabled={isPlaceholderData}>
              Use this folder
            </Button>
          </div>
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {data.parent !== undefined && (
              <FolderRow name=".." onOpen={() => setPath(data.parent)} />
            )}
            {data.folders.map((folder) => (
              <FolderRow
                key={folder.path}
                name={folder.name}
                isRepo={folder.isRepo}
                onOpen={() => setPath(folder.path)}
              />
            ))}
          </ul>
          {data.isTruncated && (
            <p className="text-muted-foreground">
              This list shows only the first {data.folders.length} folders.
            </p>
          )}
        </>
      )}
    </div>
  );
};

type FolderRowProps = { name: string; isRepo?: boolean; onOpen: () => void };

const FolderRow = (props: FolderRowProps) => {
  const { name, isRepo, onOpen } = props;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left font-mono hover:bg-muted"
      >
        <span className="truncate">{name}</span>
        {isRepo && <span className="text-muted-foreground">repo</span>}
      </button>
    </li>
  );
};
