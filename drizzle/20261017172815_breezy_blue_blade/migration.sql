CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `application_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`vacancyId` text NOT NULL UNIQUE,
	`companyName` text NOT NULL,
	`positionTitle` text NOT NULL,
	`salaryText` text NOT NULL,
	`vacancyUrl` text NOT NULL,
	`coverLetter` text NOT NULL,
	`status` text NOT NULL,
	`lastEmployerMessage` text,
	`isNotified` integer DEFAULT false NOT NULL,
	`appliedAt` text NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `search_filters` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`queryText` text NOT NULL,
	`excludedWords` text,
	`areaId` text,
	`schedule` text,
	`salaryFrom` integer
);
--> statement-breakpoint
CREATE TABLE `user_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`hhResumeTitle` text NOT NULL,
	`resumeRawText` text NOT NULL,
	`customPromptRules` text
);
