ALTER TABLE `ef_members` MODIFY COLUMN `role` enum('admin','project_manager','guest_manager','checkin','draw','merchant') NOT NULL;
--> statement-breakpoint
ALTER TABLE `ef_invites` MODIFY COLUMN `role` enum('admin','project_manager','guest_manager','checkin','draw','merchant') NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ef_system_admins` (
  `user_id` int NOT NULL,
  `granted_by` int NOT NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`user_id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `ef_access_audit` (
  `id` varchar(36) NOT NULL,
  `actor_user_id` int NOT NULL,
  `target_user_id` int NOT NULL,
  `action` varchar(80) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ef_access_audit_created_idx` (`created_at`)
);
