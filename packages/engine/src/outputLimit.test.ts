import { describe, expect, it } from "vitest";

import { type OutputChunk, OutputLimit } from "./outputLimit";

const out = (text: string): OutputChunk => ({ stream: "stdout", text });
const err = (text: string): OutputChunk => ({ stream: "stderr", text });

describe("OutputLimit", () => {
  it("gives all output at once while it fits in the first part", () => {
    const limit = new OutputLimit(4);

    expect([limit.push(out("ab")), limit.push(err("cd"))]).toEqual([out("ab"), err("cd")]);
    expect(limit.end()).toEqual({ cutLength: 0, tail: [] });
  });

  it("keeps output after the first part for the end, without a cut while it fits", () => {
    const limit = new OutputLimit(4);

    expect(limit.push(out("abcdef"))).toEqual(out("abcd"));
    expect(limit.push(err("gh"))).toBeUndefined();

    expect(limit.end()).toEqual({ cutLength: 0, tail: [out("ef"), err("gh")] });
  });

  it("cuts the output between the first and the last part", () => {
    const limit = new OutputLimit(4);
    limit.push(out("abcd"));
    limit.push(out("efg"));
    limit.push(err("hij"));

    expect(limit.end()).toEqual({ cutLength: 2, tail: [out("g"), err("hij")] });
  });
});
