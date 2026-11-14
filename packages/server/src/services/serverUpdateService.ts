import type { Build } from "@halinka/protocol";

import type { UpdateCheck } from "../updateCheck";

export class ServerUpdateService {
  constructor(
    private readonly build: Build,
    private readonly updateCheck: UpdateCheck | undefined,
  ) {}

  get() {
    const update = this.updateCheck?.status;
    return { currentVersion: this.build.version, ...(update && { update }) };
  }
}
