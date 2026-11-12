import { isDefinedError } from "@orpc/client";
import { createProcedureClient, os } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";

import { ServiceError } from "../services/serviceError";
import { apiErrors } from "./contract";
import { mapServiceErrors } from "./errorInterceptor";

const failure = async (call: () => Promise<unknown>) =>
  call().then(
    () => undefined,
    (error: unknown) => error,
  );

describe("mapServiceErrors", () => {
  it("gives a ServiceError in an event stream to the client with its code", async () => {
    const procedure = os.errors({ NOT_FOUND: apiErrors.NOT_FOUND }).handler(async function* () {
      yield 1;
      throw new ServiceError("NOT_FOUND", "There is no run 2");
    });
    const events = await createProcedureClient(procedure, { interceptors: [mapServiceErrors] })();
    await events.next();

    const error = await failure(() => events.next());

    expect(isDefinedError(error)).toBe(true);
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, message: "There is no run 2" });
  });

  it("logs a ServiceError that the procedure does not declare", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new ServiceError("RUNNER_OFFLINE", "The runner is not connected");
    const procedure = os.handler(() => {
      throw thrown;
    });

    const error = await failure(
      createProcedureClient(procedure, { interceptors: [mapServiceErrors] }),
    );

    expect(isDefinedError(error)).toBe(false);
    expect(error).toMatchObject({ code: "RUNNER_OFFLINE", status: 503 });
    expect(log).toHaveBeenCalledExactlyOnceWith(thrown);
  });
});
