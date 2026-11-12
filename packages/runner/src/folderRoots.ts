import { invalidInput } from "@halinka/protocol";
import { hostGit } from "@halinka/sandbox/host";
import { findNearestRealPath, findRealPath, isFolder, isInsideFolder } from "@halinka/utils/fs";

import { requireAbsolute } from "./repoFiles";

// The runner owns its machine: the server reaches only these folders.
export class FolderRoots {
  private readonly realRoots: Promise<string[]>;
  private readonly realHome: Promise<string>;

  constructor(
    private readonly roots: string[],
    private readonly home: string,
  ) {
    this.realRoots = Promise.all(roots.map(async (root) => (await findRealPath(root)) ?? root));
    this.realHome = findRealPath(home).then((real) => real ?? home);
  }

  get first() {
    return this.roots[0]!;
  }

  private ofRunner(path: string) {
    return invalidInput(
      `The server cannot reach ${path}: it holds the folder of this runner, ${this.home}.`,
    );
  }

  private outside(path: string) {
    return invalidInput(
      `${path} is outside the folders of this runner. Its owner can add it with --root.`,
    );
  }

  async requireInRoots(path: string) {
    requireAbsolute(path);
    // `..` means another folder to the kernel than to a path check after a symlink or a missing folder.
    if (path.split("/").includes("..")) throw this.outside(path);
    const real = await findNearestRealPath(path);
    const realRoots = await this.realRoots;
    if (!real || !realRoots.some((root) => isInsideFolder(real, root))) throw this.outside(path);
    if (isInsideFolder(real, await this.realHome)) throw this.ofRunner(path);
  }

  // Git finds a repo in a parent folder, which can be outside the roots.
  async requireRepoInRoots(repoPath: string) {
    await this.requireInRoots(repoPath);
    if (!(await isFolder(repoPath))) return;
    const root = await hostGit(repoPath).findRoot();
    if (!root) return;
    await this.requireInRoots(root);
    // A `.halinka` of the repo, also a symlink, can be the folder of the runner.
    if (isInsideFolder(await this.realHome, (await findRealPath(root)) ?? root)) {
      throw this.ofRunner(root);
    }
  }

  async isRoot(path: string) {
    return (await this.realRoots).includes((await findRealPath(path)) ?? path);
  }
}
