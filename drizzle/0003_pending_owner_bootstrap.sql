-- MySQL DDL may commit implicitly: apply via the migration runner during a
-- controlled maintenance window, never from the application initializer.
ALTER TABLE `ef_organizations` MODIFY COLUMN `owner_user_id` int NULL;
--> statement-breakpoint
ALTER TABLE `ef_events` MODIFY COLUMN `owner_user_id` int NULL;
--> statement-breakpoint
-- This marker proves that the two fixed IDs came from this initializer. Never
-- delete it to force a retry: missing/partial state is a conflict, not a repair.
CREATE TABLE `ef_initialization_markers` (
  `marker_key` varchar(100) NOT NULL,
  `organization_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`marker_key`),
  UNIQUE KEY `ef_initialization_organization_uq` (`organization_id`),
  UNIQUE KEY `ef_initialization_event_uq` (`event_id`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
