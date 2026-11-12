import { refused, updateNeeded } from "@halinka/protocol";
import { describe, expect, it } from "vitest";

import { failWithRefusal } from "./runnerStart";
import { exitOf } from "./testing";

describe("failWithRefusal", () => {
  it.each([
    ["an update", updateNeeded("The server uses protocol version 20, not 19"), 75],
    ["a refusal", refused("An Admin revoked this runner"), 78],
    ["another error", new Error("Cannot connect"), 1],
  ])("exits after %s with code %d", (_, error, code) => {
    expect(exitOf(() => failWithRefusal("", error)).code).toBe(code);
  });

  it("exits with 75 for an update under its unit with self-update on", () => {
    const error = updateNeeded("The server uses protocol version 20, not 19");

    const options = { isUnderUnit: true, canUpdate: true };

    expect(exitOf(() => failWithRefusal("", error, options)).code).toBe(75);
  });

  it("tells the person that the service starts the build of the server", () => {
    const error = updateNeeded("The server uses protocol version 20, not 19");

    const { log } = exitOf(() =>
      failWithRefusal("", error, { isUnderUnit: true, canUpdate: true }),
    );

    expect(log).toHaveBeenCalledWith(
      "The server uses protocol version 20, not 19. The service starts the runner again with the build of the server.",
    );
  });

  it("exits with 78 for an update under its unit, where a start does not update", () => {
    const error = updateNeeded("The server uses protocol version 20, not 19");

    expect(exitOf(() => failWithRefusal("", error, { isUnderUnit: true })).code).toBe(78);
  });

  it("tells the person to run install again for an update under its unit", () => {
    const error = updateNeeded("The server uses protocol version 20, not 19");

    const { log } = exitOf(() => failWithRefusal("", error, { isUnderUnit: true }));

    expect(log).toHaveBeenCalledWith(
      "The server uses protocol version 20, not 19. Run halinka runner install again: it installs the version of the server.",
    );
  });

  it("tells the person to install the version of the server for an update", () => {
    const { log } = exitOf(() =>
      failWithRefusal("", updateNeeded("The server uses protocol version 20, not 19")),
    );

    expect(log).toHaveBeenCalledWith(
      "The server uses protocol version 20, not 19. Install the version of the server, then start the runner again.",
    );
  });
});
