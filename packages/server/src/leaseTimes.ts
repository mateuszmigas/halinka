export type LeaseTimes = { leaseSeconds: number; sweepMs: number };

export const defaultLeaseTimes: LeaseTimes = { leaseSeconds: 30, sweepMs: 10_000 };

const maxSeconds = 86_400;

const secondsFromEnv = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const seconds = Number(value);
  if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= maxSeconds)) {
    throw new Error(
      `${name} must be a number of seconds above 0, at most ${maxSeconds}. Got "${value}".`,
    );
  }
  return seconds;
};

export const leaseTimesFromEnv = (): LeaseTimes => ({
  leaseSeconds: secondsFromEnv("HALINKA_LEASE_SECONDS", defaultLeaseTimes.leaseSeconds),
  sweepMs: secondsFromEnv("HALINKA_SWEEP_SECONDS", defaultLeaseTimes.sweepMs / 1000) * 1000,
});
