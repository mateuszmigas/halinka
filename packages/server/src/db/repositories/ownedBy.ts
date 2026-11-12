import { eq, isNull } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

// null is the team.
export const ownedBy = (memberColumn: PgColumn, memberId: number | null) =>
  memberId === null ? isNull(memberColumn) : eq(memberColumn, memberId);
