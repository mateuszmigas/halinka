// GitHub holds 65536 characters, and each of the two fences can be as long as the text.
const maxFencedChars = 20_000;

const maxTitleChars = 256;

// A fence shows untrusted text with no mention and no link.
export const fencedText = (heading: string, body: string) => {
  const shown =
    body.length > maxFencedChars ? `${body.slice(0, maxFencedChars).toWellFormed()}\n[cut]` : body;
  let longestRun = 2;
  for (const [run] of shown.matchAll(/`+/g)) longestRun = Math.max(longestRun, run.length);
  const fence = "`".repeat(longestRun + 1);
  return `${heading}\n\n${fence}\n${shown}\n${fence}\n`;
};

type StepText = { title?: string; body?: string; closes?: number };

// A title notifies no mention and closes no issue; a bidi control changes its order.
const oneLine = (title: string) =>
  title
    .replace(/[\p{Cc}\s\u202A-\u202E\u2066-\u2069]+/gu, " ")
    .trim()
    .slice(0, maxTitleChars)
    .toWellFormed();

export const pullRequestText = (
  id: number,
  workflowName: string,
  { title, body, closes }: StepText = {},
) => {
  const heading = `Opened from Halinka run #${id}.`;
  const text = body === undefined ? heading : fencedText(heading, body).trimEnd();
  return {
    title: (title && oneLine(title)) || `${workflowName} (Halinka run #${id})`,
    body: closes === undefined ? text : `${text}\n\nCloses #${closes}`,
  };
};
