import { hashOf } from "@halinka/utils/hash";

import type { Repositories } from "../db/repositories";
import { newToken, newUserCode } from "../tokens";
import { noLogin, noOpenRequest, ServiceError } from "./serviceError";

const requestMinutes = 15;
const tokenMinutes = 90 * 24 * 60;

const requestEnded = () =>
  new ServiceError("BAD_REQUEST", "The login request ended. Run halinka login again.");

export class CliLoginService {
  constructor(private readonly repositories: Repositories) {}

  async start() {
    const deviceCode = newToken();
    const userCode = newUserCode();
    const { expiresAt } = await this.repositories.cliLogin.createRequest(
      userCode,
      hashOf(deviceCode),
      requestMinutes,
    );
    return { deviceCode, userCode, expiresAt };
  }

  async approve(userCode: string, memberId: number | undefined) {
    if (memberId === undefined) throw noLogin();
    const approved = await this.repositories.cliLogin.approve(userCode, memberId);
    if (!approved) throw noOpenRequest(userCode);
    return { userCode };
  }

  async exchange(deviceCode: string) {
    const { cliLogin } = this.repositories;
    const request = await cliLogin.findRequest(hashOf(deviceCode));
    if (!request) throw requestEnded();
    if (request.memberId === null) return { status: "pending" as const };
    const token = newToken();
    const exchanged = await cliLogin.exchange(request.id, hashOf(token), tokenMinutes);
    if (!exchanged) throw requestEnded();
    return { status: "approved" as const, token };
  }

  findByToken(token: string) {
    return this.repositories.cliLogin.findByToken(hashOf(token));
  }

  async list(memberId: number | undefined) {
    return memberId === undefined ? [] : this.repositories.cliLogin.listTokensByMember(memberId);
  }

  async end(id: number, memberId: number | undefined) {
    const ended = memberId && (await this.repositories.cliLogin.deleteToken(id, memberId));
    if (!ended) throw new ServiceError("NOT_FOUND", `There is no login ${id}`);
    return { id };
  }
}
