import { readFile } from "node:fs/promises";

import { expect } from "@playwright/test";

import { test } from "../utils";

test.describe("halinka status", () => {
  test("shows the server and its runner", async ({ halinka }) => {
    const server = await halinka.start();
    await server.expectRunnerConnected();

    const cli = halinka.run(["status"]);

    await cli.expectExit(0);
    await cli.expectOutput(`Server: ${server.url}`);
    await cli.waitForMatch(/^ {2}\S+ {2}connected {2}/m);
    await server.stop();
  });

  test("names the server that does not answer", async ({ halinka }) => {
    const cli = halinka.run(["status", "--server", "http://127.0.0.1:9"]);

    await cli.expectExit(1);
    await cli.expectOutput("http://127.0.0.1:9");
  });
});

test.describe("halinka open", () => {
  test("gives the address of the server to the browser command", async ({ halinka }, testInfo) => {
    const opened = testInfo.outputPath("opened");
    await halinka.installFakeBrowser(opened);

    const cli = halinka.run(["open", "--server", "http://127.0.0.1:7070"]);

    await cli.expectExit(0);
    await expect.poll(() => readFile(opened, "utf8").catch(() => "")).toContain("127.0.0.1:7070");
  });
});
