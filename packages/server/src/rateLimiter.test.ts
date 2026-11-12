import { describe, expect, it } from "vitest";

import { RateLimiter } from "./rateLimiter";

const start = 1_000_000;

const proxy = "10.0.0.5";

type RequestOptions = { remoteAddress?: string; forwardedFor?: string; now?: number };

const isAllowed = (
  limiter: RateLimiter,
  { remoteAddress = proxy, forwardedFor, now = start }: RequestOptions = {},
) => limiter.take(remoteAddress, forwardedFor, now).isAllowed;

const sendRequests = (limiter: RateLimiter, count: number, options: RequestOptions = {}) => {
  const allowed: boolean[] = [];
  for (let index = 0; index < count; index++) allowed.push(isAllowed(limiter, options));
  return allowed;
};

describe("RateLimiter", () => {
  it("allows 60 requests of one address in a minute", () => {
    expect(sendRequests(new RateLimiter(undefined), 60)).not.toContain(false);
  });

  it("refuses the 61st request of one address in a minute", () => {
    const limiter = new RateLimiter(undefined);
    sendRequests(limiter, 60);

    expect(isAllowed(limiter)).toBe(false);
  });

  it("counts each address alone", () => {
    const limiter = new RateLimiter(undefined);
    sendRequests(limiter, 61);

    expect(isAllowed(limiter, { remoteAddress: "10.0.0.6" })).toBe(true);
  });

  it("allows requests again a minute after the first request of the address", () => {
    const limiter = new RateLimiter(undefined);
    sendRequests(limiter, 61);

    expect(isAllowed(limiter, { now: start + 60_000 })).toBe(true);
  });

  it("starts the minute of each address at its own first request", () => {
    const limiter = new RateLimiter(undefined);
    isAllowed(limiter, { remoteAddress: "10.0.0.6" });
    sendRequests(limiter, 60, { now: start + 59_000 });

    expect(isAllowed(limiter, { now: start + 60_000 })).toBe(false);
  });

  it("gives the seconds until the minute of the address ends", () => {
    const limiter = new RateLimiter(undefined);
    sendRequests(limiter, 60, { now: start + 59_000 });

    expect(limiter.take(proxy, undefined, start + 60_000).retryAfterSeconds).toBe(59);
  });

  it("refuses a new address when it counts 10,000 addresses", () => {
    const limiter = new RateLimiter(undefined);
    for (let index = 0; index < 10_000; index++)
      isAllowed(limiter, { remoteAddress: `10.1.${index}` });

    expect(isAllowed(limiter)).toBe(false);
  });

  it("allows a new address when the minutes of earlier addresses ended", () => {
    const limiter = new RateLimiter(undefined);
    for (let index = 0; index < 10_000; index++)
      isAllowed(limiter, { remoteAddress: `10.1.${index}` });

    expect(isAllowed(limiter, { now: start + 60_000 })).toBe(true);
  });

  it("counts the socket address without a trusted proxy", () => {
    const limiter = new RateLimiter(undefined);
    sendRequests(limiter, 60, { forwardedFor: "1.2.3.4" });

    expect(isAllowed(limiter, { forwardedFor: "1.2.3.5" })).toBe(false);
  });

  it("counts each client that the trusted proxy names alone", () => {
    const limiter = new RateLimiter(proxy);
    sendRequests(limiter, 60, { forwardedFor: "1.2.3.4" });

    expect(isAllowed(limiter, { forwardedFor: "1.2.3.5" })).toBe(true);
  });

  it("counts the last forwarded address of the trusted proxy", () => {
    const limiter = new RateLimiter(proxy);
    sendRequests(limiter, 60, { forwardedFor: "6.6.6.6, 1.2.3.4" });

    expect(isAllowed(limiter, { forwardedFor: "1.2.3.4" })).toBe(false);
  });

  it("ignores the forwarded address of another client", () => {
    const limiter = new RateLimiter(proxy);
    sendRequests(limiter, 60, { remoteAddress: "10.0.0.9", forwardedFor: "1.2.3.4" });

    expect(isAllowed(limiter, { remoteAddress: "10.0.0.9", forwardedFor: "1.2.3.5" })).toBe(false);
  });

  it("finds the proxy in the IPv4 form of an IPv6 socket", () => {
    const limiter = new RateLimiter(proxy);
    sendRequests(limiter, 60, { remoteAddress: `::ffff:${proxy}`, forwardedFor: "1.2.3.4" });

    expect(isAllowed(limiter, { forwardedFor: "1.2.3.4" })).toBe(false);
  });
});
