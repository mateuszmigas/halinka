const splitsCharacter = (source: string, offset: number) => {
  const previous = source.charCodeAt(offset - 1);
  const current = source.charCodeAt(offset);
  return (
    (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) ||
    (previous === 13 && current === 10)
  );
};

export const editorChange = (before: string, after: string) => {
  if (before === after) return undefined;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (splitsCharacter(before, start) || splitsCharacter(after, start)) start--;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  if (
    splitsCharacter(before, before.length - suffix) ||
    splitsCharacter(after, after.length - suffix)
  )
    suffix--;
  return { start, end: before.length - suffix, text: after.slice(start, after.length - suffix) };
};
