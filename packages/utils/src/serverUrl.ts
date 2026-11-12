// The URL is committed, so it must not hold credentials.
export const isServerUrl = (value: string) => {
  const url = URL.parse(value);
  return (
    !!url &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
};

export const serverUrlHint =
  "an http or https URL without a user name, a password, a query, or a fragment";

export const normalizeUrl = (value: string) => (URL.parse(value)?.href ?? value).replace(/\/$/, "");
