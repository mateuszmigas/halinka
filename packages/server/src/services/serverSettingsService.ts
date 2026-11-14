import { SerialQueue } from "@halinka/utils/serialQueue";

import type { Repositories, ServerSettingChanges } from "../db/repositories";
import type { ServerSettings } from "../serverSettings";

export class ServerSettingsService {
  // One write at a time keeps the held settings equal to the row.
  private readonly writes = new SerialQueue();

  constructor(
    private readonly repositories: Repositories,
    private readonly serverSettings: ServerSettings,
  ) {}

  get() {
    return this.serverSettings.values;
  }

  update(changes: ServerSettingChanges) {
    return this.writes.run(async () => {
      this.serverSettings.set(await this.repositories.serverSetting.update(changes));
      return this.get();
    });
  }
}
