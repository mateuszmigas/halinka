const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export const formatDateTime = (value: string) => dateTime.format(new Date(value));
