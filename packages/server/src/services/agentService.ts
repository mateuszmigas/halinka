import { randomUUID } from "node:crypto";

import { agentPresets, findAgentPreset } from "@halinka/presets";

import { type ConnectedRunners, requireRunner, wakeProcesses } from "../connectedRunners";
import type { AgentSettings, Repositories } from "../db/repositories";
import type { DbAgentCredential, DbRunner } from "../db/schema";
import type { RunBus } from "../runBus";
import { agentFingerprint, credentialPlace, type SecretCipher } from "../secrets";
import { withoutNulls } from "../withoutNulls";
import { noRunner, ServiceError } from "./serviceError";

const requireAgent = (preset: string) => {
  if (!findAgentPreset(preset)) throw new ServiceError("NOT_FOUND", `There is no agent ${preset}`);
};

const requireVariable = (preset: string, variable: string) => {
  const known = findAgentPreset(preset)?.credentials.some((item) => item.variable === variable);
  if (!known) throw new ServiceError("NOT_FOUND", `The agent ${preset} has no ${variable}`);
};

type AgentServiceOptions = {
  repositories: Repositories;
  cipher: SecretCipher;
  bus: RunBus;
  connectedRunners: ConnectedRunners;
};

export class AgentService {
  constructor(private readonly options: AgentServiceOptions) {}

  async list(memberId?: number) {
    const { agent, agentCredential, agentTest } = this.options.repositories;
    const [settings, stored, tests, ownStored, ownTests] = await Promise.all([
      agent.list(),
      agentCredential.list(null),
      agentTest.list(null),
      memberId === undefined ? [] : agentCredential.list(memberId),
      memberId === undefined ? [] : agentTest.list(memberId),
    ]);
    return Object.values(agentPresets).map((preset) => {
      const row = settings.find((item) => item.preset === preset.id);
      const keysAndTests = (rows: DbAgentCredential[], testRows: typeof tests) => {
        const ofPreset = rows.filter((item) => item.preset === preset.id);
        const fingerprint = agentFingerprint(preset.id, ofPreset, {
          version: row?.version ?? undefined,
          model: row?.model ?? undefined,
        });
        return {
          credentials: preset.credentials.map(({ variable }) => ({
            variable,
            state: this.stateOf(ofPreset.find((item) => item.variable === variable)),
          })),
          tests: testRows
            .filter((test) => test.preset === preset.id)
            .map(({ runner, status, capabilities, error, testedWith }) =>
              withoutNulls({
                runner,
                status,
                capabilities,
                error,
                isOutdated: testedWith !== null && testedWith !== fingerprint,
              }),
            ),
        };
      };
      return {
        preset: preset.id,
        label: preset.label,
        isEnabled: row?.enabled ?? true,
        version: row?.version ?? undefined,
        defaultVersion: preset.version,
        model: row?.model ?? undefined,
        ...keysAndTests(stored, tests),
        mine: memberId === undefined ? undefined : keysAndTests(ownStored, ownTests),
      };
    });
  }

  async update(preset: string, settings: AgentSettings) {
    requireAgent(preset);
    if (Object.keys(settings).length === 0) return { preset };
    await this.options.repositories.agent.save(preset, settings);
    // The wait reason of a queued run can change.
    if (settings.isEnabled !== undefined)
      await this.options.bus.notifyQueuedRuns(this.options.repositories);
    return { preset };
  }

  async setCredential(
    { preset, variable, value }: { preset: string; variable: string; value: string },
    memberId?: number,
  ) {
    requireVariable(preset, variable);
    const place = { preset, variable, memberId: memberId ?? null };
    const sealed = this.options.cipher.seal(credentialPlace(place), value);
    await this.options.repositories.agentCredential.save({ ...place, sealed });
    return { preset };
  }

  async deleteCredential(preset: string, variable: string, memberId?: number) {
    requireVariable(preset, variable);
    await this.options.repositories.agentCredential.delete(preset, variable, memberId ?? null);
    return { preset };
  }

  async test(preset: string, runnerName: string, memberId?: number) {
    requireAgent(preset);
    const runner = await this.options.repositories.runner.findByName(runnerName);
    if (!runner) throw noRunner(runnerName);
    if (runner.allowedAgents && !runner.allowedAgents.includes(preset)) {
      throw new ServiceError("CONFLICT", `The runner ${runnerName} does not allow ${preset}`);
    }
    if (memberId !== undefined) await this.checkOwnTest(preset, runner, memberId);
    requireRunner(this.options.connectedRunners, runner.id);
    await this.options.repositories.agentTest.request(preset, {
      runnerId: runner.id,
      memberId: memberId ?? null,
      token: randomUUID(),
    });
    wakeProcesses(this.options.connectedRunners, runner.id);
    return { preset };
  }

  // Any other test spends the login of the runner or the key of the team.
  private async checkOwnTest(
    preset: string,
    { name, sandboxKind }: Pick<DbRunner, "name" | "sandboxKind">,
    memberId: number,
  ) {
    if (sandboxKind !== "devcontainer") {
      throw new ServiceError(
        "CONFLICT",
        `The runner ${name} has no container, so it cannot test your key`,
      );
    }
    const rows = await this.options.repositories.agentCredential.listByPreset(preset, memberId);
    if (rows.length === 0) throw new ServiceError("CONFLICT", `Store your key of ${preset} first`);
  }

  private stateOf(row: DbAgentCredential | undefined) {
    if (!row) return "not_set" as const;
    return this.options.cipher.open(credentialPlace(row), row.sealed) === undefined
      ? ("unreadable" as const)
      : ("set" as const);
  }
}
