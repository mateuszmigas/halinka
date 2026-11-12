CREATE TYPE "public"."sandbox_kind" AS ENUM('devcontainer', 'worktree');--> statement-breakpoint
CREATE TYPE "public"."agent_test_status" AS ENUM('requested', 'running', 'passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inbox_decision" AS ENUM('approve', 'reject', 'retry', 'accept', 'fail', 'continue', 'answered');--> statement-breakpoint
CREATE TYPE "public"."inbox_item_kind" AS ENUM('approval', 'ask_human', 'limit', 'question');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."repo_kind" AS ENUM('local', 'github');--> statement-breakpoint
CREATE TYPE "public"."runner_key_state" AS ENUM('pending', 'current', 'retired');--> statement-breakpoint
CREATE TYPE "public"."runner_state" AS ENUM('active', 'draining', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('running', 'succeeded', 'failed', 'stopped', 'cancelled', 'lost');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('running', 'succeeded', 'failed', 'cancelled', 'skipped', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."sandbox_spec" AS ENUM('running', 'stopped', 'destroyed');--> statement-breakpoint
CREATE TYPE "public"."sandbox_state" AS ENUM('running', 'stopped', 'absent');--> statement-breakpoint
CREATE TYPE "public"."workflow_run_status" AS ENUM('queued', 'running', 'waiting_input', 'expired', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_id_account_id_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_credentials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"preset" text NOT NULL,
	"variable" text NOT NULL,
	"member_id" integer,
	"sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_credentials_preset_variable_member_id_unique" UNIQUE NULLS NOT DISTINCT("preset","variable","member_id")
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"workflow_run_id" integer NOT NULL,
	"step_run_id" integer NOT NULL,
	"step_attempt_id" integer,
	"text" text NOT NULL,
	"author" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"preset" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_preset_unique" UNIQUE("preset")
);
--> statement-breakpoint
CREATE TABLE "agent_tests" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "agent_tests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"preset" text NOT NULL,
	"runner_id" integer NOT NULL,
	"member_id" integer,
	"token" text NOT NULL,
	"status" "agent_test_status" NOT NULL,
	"capabilities" jsonb,
	"error" text,
	"tested_with" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tests_runner_id_preset_member_id_unique" UNIQUE NULLS NOT DISTINCT("runner_id","preset","member_id")
);
--> statement-breakpoint
CREATE TABLE "cli_logins" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cli_logins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_code" text,
	"device_code_hash" text,
	"token_hash" text,
	"member_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_logins_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "cli_logins_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "cli_logins_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "github_apps" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_apps_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"github_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"owner_login" text NOT NULL,
	"sealed_private_key" text NOT NULL,
	"sealed_webhook_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_deliveries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"result" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_deliveries_delivery_id_unique" UNIQUE("delivery_id")
);
--> statement-breakpoint
CREATE TABLE "github_installation_repos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_installation_repos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"installation_id" integer NOT NULL,
	"github_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installation_repos_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "github_installations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"app_id" integer NOT NULL,
	"github_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"suspended" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inbox_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"workflow_run_id" integer NOT NULL,
	"step_run_id" integer NOT NULL,
	"step_attempt_id" integer,
	"kind" "inbox_item_kind" NOT NULL,
	"message" text,
	"questions" jsonb,
	"answer" jsonb,
	"decision" "inbox_decision",
	"note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "members_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"github_id" text NOT NULL,
	"login" text NOT NULL,
	"role" "member_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "members_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "pushed_branches" (
	"repo_id" integer NOT NULL,
	"branch" text NOT NULL,
	"commit" text NOT NULL,
	"pull_request_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pushed_branches_repo_id_branch_pk" PRIMARY KEY("repo_id","branch")
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repos_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"kind" "repo_kind" DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"path" text,
	"runner_id" integer,
	"github_repo_id" bigint,
	"deleting_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_runner_id_path_unique" UNIQUE("runner_id","path"),
	CONSTRAINT "repos_kind_check" CHECK (("repos"."kind" = 'local' and "repos"."runner_id" is not null and "repos"."path" is not null) or ("repos"."kind" = 'github' and "repos"."runner_id" is null and "repos"."path" is null and "repos"."github_repo_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "repo_secrets" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "repo_secrets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"name" text NOT NULL,
	"sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_secrets_repo_id_name_unique" UNIQUE("repo_id","name")
);
--> statement-breakpoint
CREATE TABLE "run_calls" (
	"workflow_run_id" integer NOT NULL,
	"call_id" text NOT NULL,
	"lease_token" text NOT NULL,
	"call_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_calls_workflow_run_id_call_id_pk" PRIMARY KEY("workflow_run_id","call_id")
);
--> statement-breakpoint
CREATE TABLE "runner_enrollments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runner_enrollments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"token_hash" text,
	"user_code" text,
	"public_key" text,
	"host_name" text,
	"os" text,
	"arch" text,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"allowed_agents" text[],
	"runner_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_enrollments_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "runner_enrollments_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "runner_keys" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runner_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"runner_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"state" "runner_key_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_keys_public_key_unique" UNIQUE("public_key")
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "runners_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"state" "runner_state" DEFAULT 'active' NOT NULL,
	"labels" text[] DEFAULT '{}' NOT NULL,
	"allowed_agents" text[],
	"os" text,
	"arch" text,
	"sandbox_kind" "sandbox_kind",
	"docker" boolean DEFAULT false NOT NULL,
	"ssh_host_key" text,
	"agents_on_path" text[] DEFAULT '{}' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "server_identities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "server_identities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"server_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"user_id" integer NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "step_attempts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "step_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"step_run_id" integer NOT NULL,
	"attempt" integer NOT NULL,
	"status" "attempt_status" DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"summary" text,
	"outcome" text,
	"outputs" jsonb,
	"commit_before" text,
	"commit_after" text,
	"changed_files" text[],
	"cost_usd" double precision,
	"active_ms" integer,
	"session_id" text,
	"session_cost_usd" double precision,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_attempts_step_run_id_attempt_unique" UNIQUE("step_run_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "step_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "step_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"workflow_run_id" integer NOT NULL,
	"step_id" text NOT NULL,
	"parent_step_run_id" integer,
	"iteration" integer,
	"status" "step_status" DEFAULT 'running' NOT NULL,
	"summary" text,
	"outcome" text,
	"outputs" jsonb,
	"reopened_step_run_id" integer,
	"reopen_before" text,
	"reopen_after" text,
	"comment_url" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "step_runs_iteration_check" CHECK (("step_runs"."parent_step_run_id" is null) = ("step_runs"."iteration" is null) and "step_runs"."iteration" >= 1)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"github_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "verifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_event_batches" (
	"workflow_run_id" integer NOT NULL,
	"batch_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_run_event_batches_workflow_run_id_batch_id_pk" PRIMARY KEY("workflow_run_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_run_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workflow_run_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workflow_run_id" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workflow_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"runner_id" integer,
	"workflow_snapshot_id" integer NOT NULL,
	"author_id" integer,
	"status" "workflow_run_status" DEFAULT 'queued' NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"test_run" boolean DEFAULT false NOT NULL,
	"branch_name" text,
	"concurrency_group" text,
	"branch" text GENERATED ALWAYS AS (coalesce(branch_name, 'halinka/run-' || id::text)) STORED NOT NULL,
	"created_branch" boolean DEFAULT false NOT NULL,
	"base_sha" text NOT NULL,
	"definition_sha" text NOT NULL,
	"pull_request_number" integer,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"lease_holder" text,
	"cancel_requested_at" timestamp with time zone,
	"error" text,
	"sandbox" "sandbox_spec",
	"sandbox_kind" "sandbox_kind",
	"sandbox_kept_at" timestamp with time zone,
	"sandbox_generation" integer DEFAULT 0 NOT NULL,
	"sandbox_observed" "sandbox_state",
	"sandbox_observed_generation" integer,
	"sandbox_attach" jsonb,
	"workspace_opened" boolean DEFAULT false NOT NULL,
	"sandbox_error" text,
	"deleting_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_snapshots" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workflow_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"path" text NOT NULL,
	"content_hash" text NOT NULL,
	"files" jsonb NOT NULL,
	"resolved" jsonb NOT NULL,
	"devcontainer" text,
	"setup_network" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"setup_run" text,
	"setup_secrets" text[] DEFAULT '{}' NOT NULL,
	"runs_on" text[] DEFAULT '{}' NOT NULL,
	"agents" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_snapshots_repo_id_path_content_hash_unique" UNIQUE("repo_id","path","content_hash")
);
--> statement-breakpoint
CREATE TABLE "workflow_schedules" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workflow_schedules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo_id" integer NOT NULL,
	"path" text NOT NULL,
	"schedule" text NOT NULL,
	"next_fire_at" timestamp with time zone NOT NULL,
	"last_fire_at" timestamp with time zone,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_schedules_repo_id_path_unique" UNIQUE("repo_id","path")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_step_attempt_id_step_attempts_id_fk" FOREIGN KEY ("step_attempt_id") REFERENCES "public"."step_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tests" ADD CONSTRAINT "agent_tests_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tests" ADD CONSTRAINT "agent_tests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD CONSTRAINT "cli_logins_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_repos" ADD CONSTRAINT "github_installation_repos_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_app_id_github_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."github_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_step_attempt_id_step_attempts_id_fk" FOREIGN KEY ("step_attempt_id") REFERENCES "public"."step_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pushed_branches" ADD CONSTRAINT "pushed_branches_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_secrets" ADD CONSTRAINT "repo_secrets_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_calls" ADD CONSTRAINT "run_calls_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_enrollments" ADD CONSTRAINT "runner_enrollments_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_keys" ADD CONSTRAINT "runner_keys_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_attempts" ADD CONSTRAINT "step_attempts_step_run_id_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_parent_step_run_id_step_runs_id_fk" FOREIGN KEY ("parent_step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_runs" ADD CONSTRAINT "step_runs_reopened_step_run_id_step_runs_id_fk" FOREIGN KEY ("reopened_step_run_id") REFERENCES "public"."step_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_event_batches" ADD CONSTRAINT "workflow_run_event_batches_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_snapshot_id_workflow_snapshots_id_fk" FOREIGN KEY ("workflow_snapshot_id") REFERENCES "public"."workflow_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_author_id_members_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_snapshots" ADD CONSTRAINT "workflow_snapshots_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_schedules" ADD CONSTRAINT "workflow_schedules_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_messages_step_run_id_idx" ON "agent_messages" USING btree ("step_run_id");--> statement-breakpoint
CREATE INDEX "agent_messages_undelivered_idx" ON "agent_messages" USING btree ("workflow_run_id") WHERE "agent_messages"."delivered_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "github_apps_one_row_idx" ON "github_apps" USING btree ((true));--> statement-breakpoint
CREATE INDEX "github_installation_repos_installation_id_idx" ON "github_installation_repos" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "inbox_items_workflow_run_id_idx" ON "inbox_items" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "inbox_items_step_run_id_idx" ON "inbox_items" USING btree ("step_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_items_attempt_item_idx" ON "inbox_items" USING btree ("step_attempt_id") WHERE "inbox_items"."questions" is null;--> statement-breakpoint
CREATE INDEX "inbox_items_undelivered_idx" ON "inbox_items" USING btree ("workflow_run_id") WHERE "inbox_items"."decision" is not null and "inbox_items"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "inbox_items_pending_idx" ON "inbox_items" USING btree ("id") WHERE "inbox_items"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_github_repo_idx" ON "repos" USING btree ("github_repo_id") WHERE "repos"."kind" = 'github';--> statement-breakpoint
CREATE INDEX "runner_enrollments_public_key_idx" ON "runner_enrollments" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_keys_current_idx" ON "runner_keys" USING btree ("runner_id") WHERE "runner_keys"."state" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "runner_keys_pending_idx" ON "runner_keys" USING btree ("runner_id") WHERE "runner_keys"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "server_identities_one_row_idx" ON "server_identities" USING btree ((true));--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "step_runs_workflow_run_id_step_id_idx" ON "step_runs" USING btree ("workflow_run_id","step_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "workflow_run_events_workflow_run_id_seq_idx" ON "workflow_run_events" USING btree ("workflow_run_id","seq");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_runs_repo_id_idx" ON "workflow_runs" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_runner_id_idx" ON "workflow_runs" USING btree ("runner_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_author_id_idx" ON "workflow_runs" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_concurrency_group_idx" ON "workflow_runs" USING btree ("repo_id","concurrency_group") WHERE "workflow_runs"."concurrency_group" is not null and "workflow_runs"."status" in ('queued', 'running', 'waiting_input');--> statement-breakpoint
CREATE INDEX "workflow_runs_queued_idx" ON "workflow_runs" USING btree ("id") WHERE "workflow_runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "workflow_runs_sandbox_kept_idx" ON "workflow_runs" USING btree ("sandbox_kept_at") WHERE "workflow_runs"."sandbox" <> 'destroyed';--> statement-breakpoint
CREATE INDEX "workflow_runs_sandbox_behind_idx" ON "workflow_runs" USING btree ("id") WHERE "workflow_runs"."sandbox" is not null and "workflow_runs"."sandbox_observed_generation" is distinct from "workflow_runs"."sandbox_generation" and "workflow_runs"."status" not in ('running', 'waiting_input');--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_active_branch_idx" ON "workflow_runs" USING btree ("repo_id","branch") WHERE "workflow_runs"."status" not in ('succeeded', 'failed', 'cancelled');