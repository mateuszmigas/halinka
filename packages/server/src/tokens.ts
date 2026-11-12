import { randomBytes, randomInt } from "node:crypto";

// No vowels, so a code never spells a word.
const codeLetters = "BCDFGHJKLMNPQRSTVWXZ";

export const newUserCode = () => {
  const letters = Array.from({ length: 8 }, () => codeLetters[randomInt(codeLetters.length)]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
};

export const newToken = () => randomBytes(32).toString("base64url");
