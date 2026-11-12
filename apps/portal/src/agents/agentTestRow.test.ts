import { describe, expect, it } from "vitest";

import { agentTestRowsOf } from "./agentTestRow";

type State = "set" | "not_set" | "unreadable";

const teamTest = { runner: "team-runner", status: "passed" as const, isOutdated: false };
const myTest = { runner: "my-runner", status: "failed" as const, isOutdated: false };

const agentWith = (myKey: State | undefined, teamTests = [teamTest]) => ({
  tests: teamTests,
  mine:
    myKey === undefined
      ? undefined
      : { credentials: [{ variable: "API_KEY", state: myKey }], tests: [myTest] },
});

describe("agentTestRowsOf", () => {
  it("tests the keys of the person when the person has a key set", () => {
    expect(agentTestRowsOf(agentWith("set"), false)).toEqual([
      { scope: "mine", label: "Test", tests: [myTest], canTest: true },
    ]);
  });

  it("tests the keys of the person when the key of the person is unreadable", () => {
    expect(agentTestRowsOf(agentWith("unreadable"), false)[0]?.scope).toBe("mine");
  });

  it("tests the team keys when the person has no key set", () => {
    expect(agentTestRowsOf(agentWith("not_set"), true)).toEqual([
      { scope: "team", label: "Test", tests: [teamTest], canTest: true },
    ]);
  });

  it("gives an Admin with a key a row for the own keys and a row for the team keys", () => {
    expect(agentTestRowsOf(agentWith("set"), true).map(({ label }) => label)).toEqual([
      "Your test",
      "Team test",
    ]);
  });

  it("lets only an Admin test the team keys", () => {
    expect(agentTestRowsOf(agentWith(undefined), false)[0]?.canTest).toBe(false);
  });

  it("hides the row from a member with no key and no tests", () => {
    expect(agentTestRowsOf(agentWith("not_set", []), false)).toEqual([]);
  });
});
