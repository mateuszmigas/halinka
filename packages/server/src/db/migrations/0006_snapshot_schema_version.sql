ALTER TABLE "workflow_snapshots" DROP CONSTRAINT "workflow_snapshots_repo_id_path_content_hash_unique";--> statement-breakpoint
ALTER TABLE "workflow_snapshots" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_snapshots" ALTER COLUMN "schema_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workflow_snapshots" ADD CONSTRAINT "workflow_snapshots_content_version_unique" UNIQUE("repo_id","path","content_hash","schema_version");