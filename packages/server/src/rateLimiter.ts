const maxPerMinute = 60;

const windowMs = 60_000;

const maxTrackedAddresses = 10_000;

const withoutIpv4Prefix = (address: string) => address.replace(/^::ffff:/, "");

// Behind a proxy all clients share its address; only that proxy names the client, in the last entry.
const clientAddress = (
  remoteAddress: string,
  forwardedFor: string | undefined,
  trustedProxy: string | undefined,
) => {
  const remote = withoutIpv4Prefix(remoteAddress);
  if (!trustedProxy || remote !== trustedProxy || !forwardedFor) return remote;
  return withoutIpv4Prefix(forwardedFor.split(",").at(-1)!.trim());
};

type Window = { start: number; count: number };

// Counts the requests of each client address in its own window of one minute.
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly trustedProxy: string | undefined) {}

  // `retryAfterSeconds`: the time until the window of the address ends.
  take(remoteAddress: string, forwardedFor: string | undefined, now = Date.now()) {
    const address = clientAddress(remoteAddress, forwardedFor, this.trustedProxy);
    const window = this.windowOf(address, now);
    if (!window) return { isAllowed: false, retryAfterSeconds: windowMs / 1000 };
    window.count++;
    return {
      isAllowed: window.count <= maxPerMinute,
      retryAfterSeconds: Math.ceil((window.start + windowMs - now) / 1000),
    };
  }

  private windowOf(address: string, now: number) {
    const current = this.windows.get(address);
    if (current && now - current.start < windowMs) return current;
    if (!current && this.windows.size >= maxTrackedAddresses) {
      this.deleteEnded(now);
      if (this.windows.size >= maxTrackedAddresses) return undefined;
    }
    const started = { start: now, count: 0 };
    this.windows.set(address, started);
    return started;
  }

  private deleteEnded(now: number) {
    for (const [address, { start }] of this.windows) {
      if (now - start >= windowMs) this.windows.delete(address);
    }
  }
}
