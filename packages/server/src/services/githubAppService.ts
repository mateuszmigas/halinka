import { randomBytes } from "node:crypto";

import { isLocalHostname } from "../auth/config";
import type { Db } from "../db/client";
import { inTransaction, type Repositories } from "../db/repositories";
import type { DbGitHubApp, DbRepo } from "../db/schema";
import { convertManifest, createRepoToken, readInstallations } from "../githubApi";
import { appSecretPlace, appStatePlace, type SecretCipher } from "../secrets";
import { ServiceError } from "./serviceError";

const gitHubFlowMs = 60 * 60_000;

// A later change needs a new approval of each owner.
const permissions = {
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
};
const events = ["issues", "issue_comment", "pull_request", "push"];

const actionPermissions = {
  read: { contents: "read", metadata: "read" },
  clone: { contents: "read" },
  push: { contents: "write" },
  openPullRequest: { contents: "write", pull_requests: "write", metadata: "read" },
  publishDraft: { contents: "write", pull_requests: "write", metadata: "read" },
  comment: { pull_requests: "write", metadata: "read" },
};

export type GitHubAction = keyof typeof actionPermissions;

type FlowState = { expiresAt: number; organization?: string };

const noApp = () => new ServiceError("NOT_FOUND", "No App is connected");

const alreadyConnected = ({ slug }: DbGitHubApp) =>
  new ServiceError("CONFLICT", `The App ${slug} is connected already`);

const badState = () =>
  new ServiceError("BAD_REQUEST", "This link is not valid or is too old. Create the App again.");

export class GitHubAppService {
  constructor(
    private readonly db: Db,
    private readonly repositories: Repositories,
    private readonly cipher: SecretCipher,
  ) {}

  async status() {
    const { gitHubApp } = this.repositories;
    const [app, installations, repos] = await Promise.all([
      gitHubApp.findCurrent(),
      gitHubApp.listInstallations(),
      gitHubApp.listRepos(),
    ]);
    return {
      app: app && this.viewOf(app),
      installations: installations.map(({ suspended, ...installation }) => ({
        ...installation,
        isSuspended: suspended,
        repos: repos.filter(({ installationId }) => installationId === installation.id),
      })),
    };
  }

  async manifest(origin: string, memberId: number | undefined, organization?: string) {
    const app = await this.repositories.gitHubApp.findCurrent();
    if (app) throw alreadyConnected(app);
    const state: FlowState = { expiresAt: Date.now() + gitHubFlowMs, organization };
    const owner = organization ? `organizations/${organization}/` : "";
    const url = new URL(`https://github.com/${owner}settings/apps/new`);
    const sealed = this.cipher.seal(appStatePlace(memberId), JSON.stringify(state));
    // GitHub returns the value in a URL, where a `+` can become a space.
    url.searchParams.set("state", Buffer.from(sealed, "base64").toString("base64url"));
    const manifest = {
      name: `halinka-${randomBytes(3).toString("hex")}`,
      url: origin,
      redirect_url: `${origin}/github/created`,
      setup_url: `${origin}/github`,
      setup_on_update: true,
      public: false,
      default_permissions: permissions,
      // GitHub cannot reach a local host, and it refuses events with no webhook.
      ...(!isLocalHostname(new URL(origin).hostname) && {
        default_events: events,
        hook_attributes: { url: `${origin}/api/github/webhook`, active: true },
      }),
    };
    return { url: url.href, manifest: JSON.stringify(manifest) };
  }

  async connect(memberId: number | undefined, code: string, state: string) {
    const { organization } = this.openState(memberId, state);
    const { gitHubApp, member } = this.repositories;
    const current = await gitHubApp.findCurrent();
    if (current) throw alreadyConnected(current);
    const converted = await convertManifest(code);
    const { id: githubId, owner, slug, pem, webhook_secret: webhookSecret } = converted;
    const deleteIt = `Delete it at ${converted.html_url}`;
    // The state can leak: check who owns the App.
    const admin = memberId === undefined ? undefined : await member.findById(memberId);
    const isExpectedOwner = organization
      ? owner.login.toLowerCase() === organization.toLowerCase()
      : memberId === undefined || admin?.githubId === String(owner.id);
    if (!isExpectedOwner) {
      const expected = organization ?? admin?.login ?? "you";
      throw new ServiceError(
        "CONFLICT",
        `${owner.login} owns the App ${slug}, not ${expected}. ${deleteIt}, then create the App again.`,
      );
    }
    const app = await gitHubApp.create({
      githubId,
      slug,
      ownerLogin: owner.login,
      sealedPrivateKey: this.cipher.seal(appSecretPlace(githubId, "private-key"), pem),
      sealedWebhookSecret:
        webhookSecret === null
          ? null
          : this.cipher.seal(appSecretPlace(githubId, "webhook-secret"), webhookSecret),
    });
    if (!app) {
      throw new ServiceError("CONFLICT", `Another App was connected first. ${deleteIt}.`);
    }
    return this.viewOf(app);
  }

  async disconnect() {
    const app = await this.repositories.gitHubApp.deleteCurrent();
    if (!app) throw noApp();
    return { slug: app.slug };
  }

  async refresh() {
    const app = await this.repositories.gitHubApp.findCurrent();
    if (!app) throw noApp();
    const installations = await readInstallations(app.githubId, this.requirePrivateKey(app));
    await inTransaction(this.db, async ({ gitHubApp }) => {
      const current = await gitHubApp.lockCurrent();
      if (current?.id !== app.id) {
        throw new ServiceError("CONFLICT", "The App changed during the refresh. Try again.");
      }
      await gitHubApp.saveInstallations(app.id, installations);
    });
    return this.status();
  }

  async webhookSecret() {
    const app = await this.repositories.gitHubApp.findCurrent();
    if (!app?.sealedWebhookSecret) return undefined;
    return this.cipher.open(
      appSecretPlace(app.githubId, "webhook-secret"),
      app.sealedWebhookSecret,
    );
  }

  async findRepoToken(githubRepoId: number | null, action: GitHubAction) {
    if (githubRepoId === null) return undefined;
    const { gitHubApp } = this.repositories;
    const app = await gitHubApp.findCurrent();
    if (!app) return undefined;
    const privateKey = this.requirePrivateKey(app);
    const installationId = await gitHubApp.findInstallationByRepo(githubRepoId);
    if (installationId === undefined) {
      throw new ServiceError(
        "CONFLICT",
        "The App has no access to this GitHub repo. Install the App on it and refresh, or remove its link on the GitHub page.",
      );
    }
    return createRepoToken({
      appId: app.githubId,
      privateKey,
      installationId,
      repoId: githubRepoId,
      permissions: actionPermissions[action],
    });
  }

  // For a `github` repo: it has no `gh` path.
  async requireRepoToken(githubRepoId: number | null, action: GitHubAction) {
    const access = await this.findRepoToken(githubRepoId, action);
    if (!access)
      throw new ServiceError("CONFLICT", "A GitHub repo needs the App. Connect it again.");
    return access;
  }

  // A push of a `local` repo with no token uses `gh`.
  findPushToken(
    { repoKind, githubRepoId }: { repoKind: DbRepo["kind"]; githubRepoId: number | null },
    action: GitHubAction,
  ) {
    return repoKind === "github"
      ? this.requireRepoToken(githubRepoId, action)
      : this.findRepoToken(githubRepoId, action);
  }

  private openState(memberId: number | undefined, sealed: string) {
    const base64 = Buffer.from(sealed, "base64url").toString("base64");
    const opened = this.cipher.open(appStatePlace(memberId), base64);
    if (opened === undefined) throw badState();
    const state = JSON.parse(opened) as FlowState;
    if (state.expiresAt < Date.now()) throw badState();
    return state;
  }

  private privateKeyOf({ githubId, sealedPrivateKey }: DbGitHubApp) {
    return this.cipher.open(appSecretPlace(githubId, "private-key"), sealedPrivateKey);
  }

  private requirePrivateKey(app: DbGitHubApp) {
    const privateKey = this.privateKeyOf(app);
    if (privateKey === undefined) {
      throw new ServiceError(
        "CONFLICT",
        "Halinka cannot read the key of the App: the master key changed. Disconnect the App, then create a new one.",
      );
    }
    return privateKey;
  }

  private viewOf(app: DbGitHubApp) {
    return {
      ...app,
      isReadable: this.privateKeyOf(app) !== undefined,
      installUrl: `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`,
    };
  }
}
