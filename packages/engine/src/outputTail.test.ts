import { describe, expect, it } from "vitest";

import { OutputTail } from "./outputTail";

describe("OutputTail", () => {
  it("gives the last lines of the chunks, without the final newline", () => {
    const tail = new OutputTail(2, 100);

    tail.push("one\ntw");
    tail.push("o\nthree\n");

    expect(tail.text()).toBe("two\nthree");
  });

  it("gives the end of a line that is longer than the limit", () => {
    const tail = new OutputTail(2, 5);

    tail.push("abcdefghij\n");

    expect(tail.text()).toBe("fghij");
  });

  it("keeps the last lines after much more output than the limit", () => {
    const tail = new OutputTail(2, 20);

    for (let line = 1; line <= 1000; line++) tail.push(`line ${line}\n`);

    expect(tail.text()).toBe("line 999\nline 1000");
  });
});
