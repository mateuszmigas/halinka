ALTER TABLE "runners" ADD COLUMN "version" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "build_id" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "protocol_version" integer;