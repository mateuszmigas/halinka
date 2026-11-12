import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseMasterKey, SecretCipher } from "./secrets";

const key = randomBytes(32);

describe("secrets", () => {
  it("opens a sealed value at its place", () => {
    const cipher = new SecretCipher(key);

    expect(cipher.open("here", cipher.seal("here", "sk-real-value"))).toBe("sk-real-value");
  });

  it("does not show the value in the sealed text", () => {
    const sealed = new SecretCipher(key).seal("here", "sk-real-value");

    expect(Buffer.from(sealed, "base64").toString("latin1")).not.toContain("sk-real-value");
  });

  it("seals the same value differently each time", () => {
    const cipher = new SecretCipher(key);

    expect(cipher.seal("here", "sk-real-value")).not.toBe(cipher.seal("here", "sk-real-value"));
  });

  it("opens no value at another place", () => {
    const cipher = new SecretCipher(key);

    expect(cipher.open("there", cipher.seal("here", "sk-real-value"))).toBeUndefined();
  });

  it("opens no value of another key", () => {
    const sealed = new SecretCipher(key).seal("here", "sk-real-value");

    expect(new SecretCipher(randomBytes(32)).open("here", sealed)).toBeUndefined();
  });

  it("opens no value from text that is too short", () => {
    expect(new SecretCipher(key).open("here", "c2hvcnQ=")).toBeUndefined();
  });

  it("reads a master key of 32 bytes in base64", () => {
    expect(parseMasterKey(` ${key.toString("base64")}\n`)).toEqual(key);
  });

  it("refuses a master key that is not base64", () => {
    const text = key.toString("base64");

    expect(() => parseMasterKey(`${text.slice(0, 10)}!${text.slice(10)}`)).toThrow("32 bytes");
  });

  it("refuses a master key of another length", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow("32 bytes");
  });
});
