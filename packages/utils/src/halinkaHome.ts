import { homedir } from "node:os";
import { join } from "node:path";

export const halinkaHome = () => process.env.HALINKA_HOME ?? join(homedir(), ".halinka");
