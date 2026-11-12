import type { FormIssue } from "./formErrors";

// TanStack Form field errors can contain `undefined`.
export type FormIssuesProps = { issues?: (FormIssue | undefined)[] };

export const FormIssues = (props: FormIssuesProps) => {
  const issues = (props.issues ?? []).filter((issue) => issue !== undefined);

  if (issues.length === 0) return null;

  return (
    <ul className="text-destructive">
      {issues.map(({ message, location }, index) => (
        <li key={index}>
          {location && <span className="font-mono">{`${location.line}:${location.column} `}</span>}
          {message}
        </li>
      ))}
    </ul>
  );
};
