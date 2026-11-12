import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { Build } from "@halinka/protocol";
import { authConfigFromEnv, dbLocationFromEnv, leaseTimesFromEnv, Server } from "@halinka/server";
import { errorMessage } from "@halinka/utils/errors";
import { FileLocks, type Release } from "@halinka/utils/fileLocks";
import { isFile, isFolder } from "@halinka/utils/fs";
import { halinkaHome } from "@halinka/utils/halinkaHome";

import { fail, failWithError } from "./args";
import { loadMasterKey } from "./loadMasterKey";
import { deleteLocalServerUrl, writeLocalServerUrl } from "./localServerUrl";
import { readBuild } from "./readBuild";

// The package has it next to the code, and a checkout has it in the portal app.
const portalFolders = ["./portal", "../../portal/dist"].map((path) =>
  fileURLToPath(new URL(path, import.meta.url)),
);

// The server image packs its own package next to the code; an npm install and a checkout have none.
const runnerPackageFile = fileURLToPath(new URL("../halinka.tgz", import.meta.url));

const findPortalFolder = async () => {
  for (const folder of portalFolders) if (await isFolder(folder)) return folder;
  return undefined;
};

const readAuthConfig = () => {
  try {
    return authConfigFromEnv();
  } catch (error) {
    return fail(errorMessage(error));
  }
};

export class LocalServer {
  private constructor(
    readonly server: Server,
    readonly build: Build,
    private readonly isPortalBuilt: boolean,
    private readonly release: Release,
  ) {}

  // `hasLogin`: `halinka server` can have a login; `halinka start` is for this machine.
  static async start(
    port: number,
    { hasLogin = false, host }: { hasLogin?: boolean; host?: string } = {},
  ) {
    const auth = hasLogin ? readAuthConfig() : undefined;
    const home = halinkaHome();
    // Two processes must not open one PGlite folder.
    const release =
      (await new FileLocks(home, randomUUID()).tryTake("server")) ??
      fail(`Another Halinka process runs the server of ${home}. Stop it first.`);
    const masterKey = await loadMasterKey({ hasLogin: auth !== undefined }).catch(failWithError);
    const portalFolder = await findPortalFolder();
    const build = await readBuild();
    const server = new Server({
      port,
      build,
      ...((await isFile(runnerPackageFile)) && { runnerPackageFile }),
      dbLocation: dbLocationFromEnv(),
      masterKey,
      leaseTimes: leaseTimesFromEnv(),
      ...(portalFolder && { portalFolder }),
      ...(auth && { auth }),
      ...(host && { host }),
    });
    await server.start().catch((error: unknown) => fail(errorMessage(error)));
    await writeLocalServerUrl(server.url);
    return new LocalServer(server, build, portalFolder !== undefined, release);
  }

  announce() {
    console.log(`halinka listening on ${this.server.url}`);
    console.log(
      this.isPortalBuilt
        ? `portal: ${this.server.publicUrl}`
        : "The portal is not built. Run pnpm --filter @halinka/portal build, then start again.",
    );
  }

  async stop() {
    await this.server.stop();
    await deleteLocalServerUrl();
    await this.release();
  }
}
