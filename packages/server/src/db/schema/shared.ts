import { sandboxKinds } from "@halinka/protocol";
import { sql } from "drizzle-orm";
import { pgEnum, timestamp } from "drizzle-orm/pg-core";

export const sandboxKind = pgEnum("sandbox_kind", sandboxKinds);

export const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdateFn(() => sql`now()`);
