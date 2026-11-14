import { SerialQueue } from "@halinka/utils/serialQueue";

import type { Repositories, ServerSettingChanges } from "../db/repositories";
import type { ServerSettings } from "../serverSettings";
import type { UpdateCheck } from "../updateCheck";

export class ServerSettingsService {
  // One write at a time keeps the held settings equal to the row.
  private readonly writes = new SerialQueue();

  constructor(
    private readonly repositories: Repositories,
    private readonly serverSettings: ServerSettings,
    private readonly updateCheck: UpdateCheck | undefined,
  ) {}

  get() {
    return this.serverSettings.values;
  }

  update(changes: ServerSettingChanges) {
    return this.writes.run(async () => {
      const wasCheckOn = this.get().isUpdateCheckOn;
      this.serverSettings.set(await this.repositories.serverSetting.update(changes));
      if (this.get().isUpdateCheckOn !== wasCheckOn) await this.updateCheck?.settingChanged();
      return this.get();
    });
  }
}
