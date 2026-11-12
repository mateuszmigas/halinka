import { stripVTControlCharacters } from "node:util";

// Control characters without tab and line feed, and the bidi controls: each can hide or reorder text.
const hiddenCharactersPattern = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;

// Commands, agents and a server can write text that controls the terminal.
export const safeText = (text: string) =>
  stripVTControlCharacters(text)
    .replaceAll(/\r\n?/g, "\n")
    .replaceAll(hiddenCharactersPattern, (character) =>
      character === "\t" || character === "\n" ? character : "",
    );
