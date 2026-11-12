import { errorMessage } from "@halinka/utils/errors";
import { type Backoff, backoffMs } from "@halinka/utils/retry";
import { SerialQueue } from "@halinka/utils/serialQueue";

import {
  type CodexLogin,
  CodexLoginRejected,
  codexLoginLocks,
  expiryOf,
  readCodexLogin,
  refreshCodexLogin,
  refreshTimeOf,
  saveCodexLogin,
  withCodexLoginLock,
} from "./codexLogin";
import type { Credentials } from "./credentials";

export type CodexLoginsOptions = {
  home: string;
  credentials: Pick<Credentials, "setCodexLogin">;
  writePolicies: () => Promise<void>;
  fetch?: typeof fetch;
  retry?: Backoff;
};

const refreshTimeoutMs = 30_000;
// Timers stop while the machine sleeps, so the timer checks the time often.
const maxWaitMs = 10 * 60_000;

// The saved login of `halinka agent login codex`, which the CLI can replace while the runner runs.
export class CodexLogins {
  private login: CodexLogin | undefined;
  private failures = 0;
  private retryAt = 0;
  private lastError: string | undefined;
  private rejectedRefreshToken: string | undefined;
  private isRunning = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly stopping = new AbortController();
  // One task at a time: an earlier read never replaces a later login.
  private readonly tasks = new SerialQueue();
  private readonly locks: ReturnType<typeof codexLoginLocks>;
  private readonly retry: Backoff;

  constructor(private readonly options: CodexLoginsOptions) {
    this.locks = codexLoginLocks(options.home);
    this.retry = options.retry ?? { initialDelayMs: 30_000, maxDelayMs: 30 * 60_000 };
  }

  read() {
    return this.tasks.run(async () => this.apply(await readCodexLogin(this.options.home)));
  }

  // A login that expired while the machine slept gets one refresh first.
  async readForStart() {
    await this.read();
    if (!this.isExpired()) return;
    if (!this.isRejected() && this.retryAt <= Date.now()) await this.refresh();
    if (!this.isExpired()) return;
    throw new Error(
      this.isRejected()
        ? "The Codex login of the runner expired. Run: halinka agent login codex"
        : `The Codex login of the runner expired, and its refresh failed: ${this.lastError}`,
    );
  }

  start() {
    this.isRunning = true;
    this.schedule();
  }

  // Ends a wait for the lock at once, and a refresh request within its time limit.
  async stop() {
    this.isRunning = false;
    this.stopping.abort();
    clearTimeout(this.timer);
    await this.tasks.idle();
  }

  private isExpired() {
    return this.login !== undefined && expiryOf(this.login) <= Date.now();
  }

  private isRejected() {
    return this.login?.refreshToken === this.rejectedRefreshToken;
  }

  private dueAt(login: CodexLogin) {
    return Math.max(refreshTimeOf(login), this.retryAt);
  }

  private apply(login: CodexLogin | undefined) {
    if (!login) return;
    if (login.refreshToken !== this.login?.refreshToken) {
      this.failures = 0;
      this.retryAt = 0;
    }
    this.login = login;
    // Do not wait for the proxies: a new step gets the login in its own grant.
    if (this.options.credentials.setCodexLogin(login)) void this.options.writePolicies();
    this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    const { login } = this;
    if (!this.isRunning || !login || this.isRejected()) return;
    const wait = Math.min(this.dueAt(login) - Date.now(), maxWaitMs);
    this.timer = setTimeout(
      () => {
        if (this.dueAt(login) > Date.now()) this.schedule();
        else void this.refresh();
      },
      Math.max(0, wait),
    );
  }

  // Back off outside the lock and the queue: Codex starts and CLI saves must not wait.
  private async refresh() {
    const { signal } = this.stopping;
    try {
      await this.tasks.run(() =>
        withCodexLoginLock(this.locks, () => this.refreshSaved(signal), { signal }),
      );
      this.failures = 0;
    } catch (error) {
      if (signal.aborted) return;
      this.lastError = errorMessage(error);
      console.error(`Halinka could not refresh the Codex login: ${this.lastError}`);
      this.retryAt = Date.now() + backoffMs(this.failures++, this.retry);
      this.schedule();
    }
  }

  // Another process can have refreshed the login, and a queued attempt can follow a failed one.
  private async refreshSaved(signal: AbortSignal) {
    const saved = await readCodexLogin(this.options.home);
    if (!saved) throw new Error("The saved Codex login is gone. Run: halinka agent login codex");
    const isRejected = saved.refreshToken === this.rejectedRefreshToken;
    if (isRejected || this.dueAt(saved) > Date.now()) return this.apply(saved);
    signal.throwIfAborted();
    // Without the stop signal: a stop must not lose a token that the server rotated already.
    const refreshed = await refreshCodexLogin(saved, {
      signal: AbortSignal.timeout(refreshTimeoutMs),
      fetch: this.options.fetch,
    }).catch((error: unknown) => {
      if (!(error instanceof CodexLoginRejected)) throw error;
      this.rejectedRefreshToken = saved.refreshToken;
      console.error(error.message);
      return undefined;
    });
    if (!refreshed) return this.apply(saved);
    await saveCodexLogin(this.options.home, refreshed);
    this.apply(refreshed);
    // Without it, the next attempt starts at once and sends a request in a loop.
    if (refreshTimeOf(refreshed) <= Date.now()) {
      throw new Error("The refresh gave no access token with a later expiry.");
    }
  }
}
