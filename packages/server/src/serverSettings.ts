import type { Repositories } from "./db/repositories";
import type { DbServerSetting } from "./db/schema";

export class ServerSettings {
  constructor(private row: DbServerSetting) {}

  static async load(repositories: Repositories) {
    return new ServerSettings(await repositories.serverSetting.findOrCreate());
  }

  get values() {
    return { isUpdateCheckOn: this.row.updateCheck };
  }

  set(row: DbServerSetting) {
    this.row = row;
  }
}
