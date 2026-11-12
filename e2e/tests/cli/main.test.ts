import { test } from "../utils";

test.describe("halinka", () => {
  test("prints the usage without a command", async ({ halinka }) => {
    const cli = halinka.run([]);
    await cli.expectExit(0);
    await cli.expectOutput("Usage: halinka <command>");
  });

  test("refuses an unknown command", async ({ halinka }) => {
    const cli = halinka.run(["deploy"]);
    await cli.expectExit(1);
    await cli.expectOutput("Usage: halinka <command>");
  });

  test("prints the usage of a command with --help", async ({ halinka }) => {
    const cli = halinka.run(["start", "--help"]);
    await cli.expectExit(0);
    await cli.expectOutput("Usage: halinka start [options]");
  });
});
