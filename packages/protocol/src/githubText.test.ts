import { describe, expect, it } from "vitest";

import { fencedText, pullRequestText } from "./githubText";

describe("githubText", () => {
  it("uses a fence longer than each run of backticks in the text", () => {
    const text = fencedText("Heading", "````\n@octo [link](https://example.com)\n````");

    expect(text).toBe("Heading\n\n`````\n````\n@octo [link](https://example.com)\n````\n`````\n");
  });

  it("marks the cut of a long text", () => {
    expect(fencedText("Heading", "x".repeat(70_000))).toContain("[cut]");
  });

  it("stays in the limit of GitHub for a text of only backticks", () => {
    expect(fencedText("Heading", "`".repeat(70_000)).length).toBeLessThan(65_536);
  });

  it("uses a fence of three for a text with short runs of backticks", () => {
    expect(fencedText("Heading", "` ".repeat(100))).toContain("\n```\n");
  });

  it("does not leave half of a character at the cut", () => {
    const text = fencedText("Heading", `${"x".repeat(19_999)}😀`);

    expect(text.isWellFormed()).toBe(true);
  });

  it("gives the fixed text with no step text", () => {
    expect(pullRequestText(9, "Issue to PR")).toEqual({
      title: "Issue to PR (Halinka run #9)",
      body: "Opened from Halinka run #9.",
    });
  });

  it("closes the issue after the fenced step body", () => {
    const { body } = pullRequestText(9, "Issue to PR", { body: "Fixes #1 @octo", closes: 133 });

    expect(body).toBe("Opened from Halinka run #9.\n\n```\nFixes #1 @octo\n```\n\nCloses #133");
  });

  it("closes the issue with no step body", () => {
    expect(pullRequestText(9, "Issue to PR", { closes: 133 }).body).toBe(
      "Opened from Halinka run #9.\n\nCloses #133",
    );
  });

  it("makes the step title one line", () => {
    expect(pullRequestText(9, "Issue to PR", { title: " Add\n\tshapes\u0007 " }).title).toBe(
      "Add shapes",
    );
  });

  it("removes bidi controls from the title", () => {
    expect(pullRequestText(9, "Issue to PR", { title: "Add\u202Eshapes" }).title).toBe(
      "Add shapes",
    );
  });

  it("cuts a long title with no half of a character", () => {
    const { title } = pullRequestText(9, "Issue to PR", { title: `${"x".repeat(255)}😀` });

    expect(title).toHaveLength(256);
    expect(title.isWellFormed()).toBe(true);
  });

  it("gives the fixed title for a title of only spaces", () => {
    expect(pullRequestText(9, "Issue to PR", { title: " \n " }).title).toBe(
      "Issue to PR (Halinka run #9)",
    );
  });
});
