import { sql } from "drizzle-orm";

// The share lock makes a revoke or a new key wait; aliases, as drizzle drops tables without a join.
export const hasAuthority = (runnerId: number, publicKey: string) =>
  sql`exists (select 1 from runners r join runner_keys k on k.runner_id = r.id where r.id = ${runnerId} and r.state <> 'revoked' and k.public_key = ${publicKey} and k.state = 'current' for share of r, k)`;
