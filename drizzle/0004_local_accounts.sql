-- Username/password accounts for staff, merchants and members who do not use
-- Google. Password hashes are scrypt; the raw password is never stored.
-- Additive only; apply through the migration runner (pnpm db:migrate).
CREATE TABLE `ef_local_accounts` (
  `id` varchar(36) NOT NULL,
  `username` varchar(64) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `display_name` varchar(200) NOT NULL,
  `kind` enum('staff','member') NOT NULL,
  `user_id` int NULL,
  `event_id` varchar(36) NULL,
  `guest_id` varchar(36) NULL,
  `active` tinyint NOT NULL DEFAULT 1,
  `created_by` int NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `last_login_at` datetime(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ef_local_accounts_username_uq` (`username`),
  UNIQUE KEY `ef_local_accounts_user_uq` (`user_id`),
  KEY `ef_local_accounts_guest_idx` (`event_id`,`guest_id`)
) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
