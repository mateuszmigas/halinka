import { parseCommandArgs } from "./args";
import { setupInstructions } from "./setupInstructions";

const usage = `Usage: halinka setup

Prints instructions for a coding agent that sets up Halinka in a repo. It changes nothing.`;

export const setup = async (args: string[]) => {
  parseCommandArgs(args, {}, usage);
  console.log(setupInstructions);
};
