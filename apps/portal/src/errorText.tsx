export type ErrorTextProps = { error: Error | null | undefined };

export const ErrorText = (props: ErrorTextProps) => {
  const { error } = props;

  if (!error) return null;

  return <p className="text-destructive">{error.message}</p>;
};
