import { protocolVersion } from "@halinka/protocol";
import { errorMessage } from "@halinka/utils/errors";
import { z } from "zod";

import type { ServerSettings } from "./serverSettings";

export type ServerCommand = "start" | "server";

const latestUrl = "https://registry.npmjs.org/halinka/latest";

const checkMs = 24 * 60 * 60 * 1000;

const timeoutMs = 10_000;

const latestSchema = z.object({
  version: z.string(),
  protocolVersion: z.number().int().optional(),
});

type Latest = z.infer<typeof latestSchema>;

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

const partsOf = (version: string) => versionPattern.exec(version)?.slice(1).map(Number);

// The release workflow publishes only `X.Y.Z`.
const isNewerVersion = (version: string, than: string) => {
  const parts = partsOf(version);
  const thanParts = partsOf(than);
  if (!parts || !thanParts) return false;
  const index = parts.findIndex((part, i) => part !== thanParts[i]);
  return index !== -1 && parts[index]! > thanParts[index]!;
};

export class UpdateCheck {
  private latest: Latest | undefined;

  private checking: Promise<void> | undefined;

  private request: AbortController | undefined;

  private timer: NodeJS.Timeout | undefined;

  private isStopped = false;

  constructor(
    private readonly currentVersion: string,
    private readonly command: ServerCommand,
    private readonly settings: ServerSettings,
  ) {}

  get status() {
    const { latest } = this;
    if (!latest || !isNewerVersion(latest.version, this.currentVersion)) return undefined;
    return {
      latestVersion: latest.version,
      // Older releases have no `protocolVersion`.
      isProtocolChange:
        latest.protocolVersion !== undefined && latest.protocolVersion !== protocolVersion,
      command: this.command,
    };
  }

  start() {
    void this.check();
    this.timer = setInterval(() => void this.check(), checkMs);
  }

  check() {
    if (this.isStopped || !this.settings.values.isUpdateCheckOn) return Promise.resolve();
    this.checking ??= this.read().finally(() => (this.checking = undefined));
    return this.checking;
  }

  async settingChanged() {
    await this.cancel();
    this.latest = undefined;
    void this.check();
  }

  async stop() {
    this.isStopped = true;
    clearInterval(this.timer);
    await this.cancel();
  }

  private async cancel() {
    this.request?.abort();
    await this.checking;
  }

  private async read() {
    const request = new AbortController();
    this.request = request;
    try {
      const answer = await fetch(latestUrl, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!answer.ok) throw new Error(`The npm registry answered ${answer.status}`);
      this.latest = latestSchema.parse(await answer.json());
    } catch (error) {
      if (!request.signal.aborted) console.error(`The update check failed: ${errorMessage(error)}`);
    }
  }
}
