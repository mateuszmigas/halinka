ALTER TABLE "runners" ADD COLUMN "sysbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_snapshots" ADD COLUMN "setup_docker" boolean DEFAULT false NOT NULL;