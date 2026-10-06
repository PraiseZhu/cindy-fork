CREATE TABLE `automation_dispatch_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_kind` text NOT NULL,
	`principal_id` text NOT NULL,
	`request_key` text NOT NULL,
	`operation` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`session_id` text,
	`input_id` text,
	`worker_id` text,
	`team_id` text,
	`wake_kind` text,
	`error_code` text,
	`result` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_automation_dispatch_principal_key` ON `automation_dispatch_receipts` (`principal_kind`,`principal_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `idx_automation_dispatch_session` ON `automation_dispatch_receipts` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_automation_dispatch_team` ON `automation_dispatch_receipts` (`team_id`);--> statement-breakpoint
CREATE TABLE `orca_worker_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`logical_report_id` text NOT NULL,
	`team_id` text NOT NULL,
	`worker_id` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_generation` integer NOT NULL,
	`event_kind` text NOT NULL,
	`work_revision` text DEFAULT '' NOT NULL,
	`evidence_revision` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`report` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `orca_teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_orca_worker_events_event_id` ON `orca_worker_events` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_orca_worker_events_team_seq` ON `orca_worker_events` (`team_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_orca_worker_events_logical` ON `orca_worker_events` (`logical_report_id`);
