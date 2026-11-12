import type { Repositories } from "../db/repositories";
import { repoSecretPlace, type SecretCipher } from "../secrets";
import { noRepo } from "./serviceError";

export class RepoSecretService {
  constructor(
    private readonly repositories: Repositories,
    private readonly cipher: SecretCipher,
  ) {}

  async list(repoId: number) {
    await this.checkRepo(repoId);
    const rows = await this.repositories.repoSecret.listByRepo(repoId);
    return rows.map((row) => ({
      name: row.name,
      isReadable: this.cipher.open(repoSecretPlace(repoId, row.name), row.sealed) !== undefined,
    }));
  }

  async set(repoId: number, name: string, value: string) {
    await this.checkRepo(repoId);
    const sealed = this.cipher.seal(repoSecretPlace(repoId, name), value);
    await this.repositories.repoSecret.save({ repoId, name, sealed });
    return { name };
  }

  async delete(repoId: number, name: string) {
    await this.checkRepo(repoId);
    await this.repositories.repoSecret.delete(repoId, name);
    return { name };
  }

  private async checkRepo(repoId: number) {
    const repo = await this.repositories.repo.findById(repoId);
    if (!repo) throw noRepo(repoId);
  }
}
