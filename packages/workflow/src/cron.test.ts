import { describe, expect, it } from "vitest";

import { nextCronTime } from "./cron";

const after = new Date("2026-11-04T10:30:15Z");

describe("nextCronTime", () => {
  it.each([
    ["* * * * *", "2026-11-04T10:31:00Z"],
    ["*/15 * * * *", "2026-11-04T10:45:00Z"],
    ["0 6 * * *", "2026-11-05T06:00:00Z"],
    ["45,35 10 * * *", "2026-11-04T10:35:00Z"],
    ["0 8-20/6 * * *", "2026-11-04T14:00:00Z"],
    ["0 0 1 * *", "2026-12-01T00:00:00Z"],
    ["0 0 1 1 *", "2027-01-01T00:00:00Z"],
    ["0 9 * * 1-5", "2026-11-05T09:00:00Z"],
    ["0 9 * * 0", "2026-11-08T09:00:00Z"],
    ["  30   10 * * *  ", "2026-11-05T10:30:00Z"],
  ])("gives the next time of %s", (schedule, expected) => {
    expect(nextCronTime(schedule, after)).toEqual(new Date(expected));
  });

  it("gives a time strictly after the given time", () => {
    const time = new Date("2026-11-04T10:45:00Z");

    expect(nextCronTime("45 10 * * *", time)).toEqual(new Date("2026-11-05T10:45:00Z"));
  });

  it("takes either day when both day fields have values", () => {
    expect(nextCronTime("0 0 20 * 5", after)).toEqual(new Date("2026-11-06T00:00:00Z"));
  });

  it("needs both day fields when one starts with a star", () => {
    expect(nextCronTime("0 0 */2 * 5", after)).toEqual(new Date("2026-11-13T00:00:00Z"));
  });

  it("finds 29 February over a year with no such day", () => {
    const time = new Date("2096-03-01T00:00:00Z");

    expect(nextCronTime("0 0 29 2 *", time)).toEqual(new Date("2104-02-29T00:00:00Z"));
  });

  it("finds a day and a weekday that come together after more than 8 years", () => {
    const time = new Date("2035-02-01T00:00:00Z");

    expect(nextCronTime("0 0 */31 2 4", time)).toEqual(new Date("2046-02-01T00:00:00Z"));
  });

  it.each([
    ["no text", ""],
    ["four fields", "* * * *"],
    ["six fields", "0 * * * * *"],
    ["a minute out of range", "60 * * * *"],
    ["an hour out of range", "0 24 * * *"],
    ["a day out of range", "0 0 0 * *"],
    ["a month out of range", "0 0 1 13 *"],
    ["a weekday out of range", "0 0 * * 7"],
    ["a range in reverse", "0 20-8 * * *"],
    ["a step of zero", "*/0 * * * *"],
    ["a step on one number", "5/15 * * * *"],
    ["a name", "0 0 * JAN *"],
    ["an empty list item", "0, * * * *"],
    ["a date that does not exist", "0 0 30 2 *"],
  ])("refuses %s", (_name, schedule) => {
    expect(nextCronTime(schedule, after)).toBeUndefined();
  });
});
