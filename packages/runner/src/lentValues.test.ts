import { describe, expect, it } from "vitest";

import { LentValues } from "./lentValues";

const lentValues = (...values: string[]) => {
  const lent = new LentValues();
  for (const value of values) lent.add("API_KEY", value);
  return lent;
};

describe("LentValues", () => {
  it("masks each match of a lent value", () => {
    const lent = lentValues("sk-secret-1");

    expect(lent.mask("sk-secret-1 and sk-secret-1.")).toBe("*** and ***.");
  });

  it("masks a removed value no more", () => {
    const lent = lentValues("sk-secret-1", "sk-secret-2");

    lent.delete("sk-secret-1");

    expect(lent.mask("sk-secret-1 sk-secret-2")).toBe("sk-secret-1 ***");
  });

  it("masks the values of nested objects and arrays", () => {
    const lent = lentValues("sk-secret-1");

    const masked = lent.mask({ outputs: { found: ["key sk-secret-1"] }, exitCode: 1 });

    expect(masked).toEqual({ outputs: { found: ["key ***"] }, exitCode: 1 });
  });

  it("masks object keys", () => {
    const lent = lentValues("sk-secret-1");

    expect(lent.mask({ "sk-secret-1": true })).toEqual({ "***": true });
  });

  it("masks the longer value first when a value is inside another value", () => {
    const lent = lentValues("cdefghij", "abcdefghijkl");

    expect(lent.mask("<abcdefghijkl>")).toBe("<***>");
  });

  it("finds the name of a lent value in a text", () => {
    const lent = new LentValues();
    lent.add("API_KEY", "sk-secret-1");
    lent.add("OAUTH_TOKEN", "sk-secret-2");

    expect(lent.find("token=sk-secret-2;")).toBe("OAUTH_TOKEN");
  });

  it("finds no name in a text without a lent value", () => {
    expect(lentValues("sk-secret-1").find("sk-secret-")).toBeUndefined();
  });

  it("gives the length of the longest end of a text that starts a lent value", () => {
    expect(lentValues("sk-secret-1", "token-abcdefgh").heldLength("a=sk-secret b=token-")).toBe(6);
  });

  it("gives no held length for a text whose end starts no lent value", () => {
    expect(lentValues("sk-secret-1").heldLength("tests passed")).toBe(0);
  });

  it("gives no held length for a whole lent value", () => {
    expect(lentValues("sk-secret-1").heldLength("sk-secret-1")).toBe(0);
  });

  it("keeps a whole value that is the start of a longer value", () => {
    expect(lentValues("abcdefgh", "abcdefghXYZ").heldLength("key abcdefgh")).toBe(8);
  });

  it("keeps a whole value that ends in the start of another value", () => {
    expect(lentValues("12345678", "5678wxyz").heldLength("key 12345678")).toBe(8);
  });

  it("refuses a value that is too short to mask", () => {
    expect(() => lentValues("short")).toThrow("API_KEY has fewer than 8 characters");
  });
});
