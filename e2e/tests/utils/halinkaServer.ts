import { expect } from "@playwright/test";

import type { HalinkaProcess } from "./halinkaProcess";

export class HalinkaServer {
  constructor(
    private readonly process: HalinkaProcess,
    readonly url: string,
  ) {}

  async expectHealthy() {
    const response = await fetch(`${this.url}/api/health`);
    expect(await response.json()).toEqual({ ok: true });
    return this;
  }

  async expectRunnerConnected() {
    await this.process.expectOutput("runner connected");
    return this;
  }

  async expectRepoRegistered(path: string) {
    await this.process.expectOutput(`registered the repo ${path}`);
    return this;
  }

  async expectRepoConfigProblem(problem: string) {
    await this.process.expectOutput(".halinka/config.yml is not valid. start registers no repo.");
    await this.process.expectOutput(`.halinka/config.yml:${problem}`);
    return this;
  }

  async postJson<T>(path: string, body: unknown) {
    const response = await this.post(path, body);
    expect(response.ok, await response.clone().text()).toBe(true);
    return (await response.json()) as T;
  }

  async get(path: string) {
    return (await fetch(`${this.url}${path}`)).json();
  }

  post(path: string, body: unknown) {
    return fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  delete(path: string) {
    return fetch(`${this.url}${path}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
  }

  async crash() {
    await this.process.kill();
  }

  async stop() {
    await this.process.interrupt().expectExit(0);
  }
}
