import { type ApiError, apiIssues } from "@halinka/server/client";

export type FormIssue = { message: string; location?: { line: number; column: number } };

export type FormErrors<Field extends string> = {
  form?: FormIssue[];
  fields: Partial<Record<Field, FormIssue[]>>;
};

type Problem = { message: string; line: number; column: number };

export const problemIssues = (problems: Problem[]): FormIssue[] =>
  problems.map(({ message, line, column }) => ({ message, location: { line, column } }));

export const toFormErrors = <Field extends string>(
  error: ApiError,
  fields: readonly Field[],
): FormErrors<Field> => {
  const issues = apiIssues(error);
  if (issues.length === 0) return { form: [{ message: error.message }], fields: {} };
  const result: FormErrors<Field> = { fields: {} };
  for (const { field: name, message, location } of issues) {
    const issue = location ? { message, location } : { message };
    const field = fields.find((candidate) => candidate === name);
    if (field) (result.fields[field] ??= []).push(issue);
    else (result.form ??= []).push(issue);
  }
  return result;
};
