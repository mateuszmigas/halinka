CREATE TYPE "public"."runner_update_request" AS ENUM('when_idle', 'now');--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "can_update" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "auto_update" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "update_request" "runner_update_request";--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "update_failure" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "update_failed_build_id" text;