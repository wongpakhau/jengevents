CREATE TABLE IF NOT EXISTS `ef_organizations` (
  `id` varchar(36) NOT NULL,
  `owner_user_id` int NOT NULL,
  `name` varchar(200) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `ef_organizations_owner_idx` (`owner_user_id`)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `ef_events` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `owner_user_id` int NOT NULL,
  `slug` varchar(160) NOT NULL,
  `event_state` LONGTEXT NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ef_events_slug_uq` (`slug`),
  KEY `ef_events_tenant_idx` (`tenant_id`),
  KEY `ef_events_owner_idx` (`owner_user_id`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `ef_members` (
  `id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `user_id` int NOT NULL,
  `name` varchar(200) NOT NULL,
  `role` enum('admin','checkin','draw','merchant') NOT NULL,
  `merchant_id` varchar(36) NULL,
  `active` tinyint(1) NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ef_members_event_user_uq` (`event_id`, `user_id`),
  KEY `ef_members_user_idx` (`user_id`),
  KEY `ef_members_event_active_idx` (`event_id`, `active`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `ef_invites` (
  `id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `kind` enum('staff','guest','receipt') NOT NULL,
  `token_hash` char(64) NOT NULL,
  `guest_id` varchar(36) NULL,
  `role` enum('admin','checkin','draw','merchant') NULL,
  `merchant_id` varchar(36) NULL,
  `name` varchar(200) NULL,
  `version` int NOT NULL DEFAULT 1,
  `expires_at` datetime(3) NULL,
  `consumed_by_user_id` int NULL,
  `claimed_by_guest_id` varchar(36) NULL,
  `consumed_at` datetime(3) NULL,
  `revoked_at` datetime(3) NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ef_invites_token_hash_uq` (`token_hash`),
  KEY `ef_invites_event_kind_idx` (`event_id`, `kind`),
  KEY `ef_invites_guest_idx` (`guest_id`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `ef_idempotency` (
  `id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `action` varchar(100) NOT NULL,
  `actor_scope` varchar(128) NOT NULL,
  `idempotency_key` varchar(200) NOT NULL,
  `request_hash` char(64) NOT NULL,
  `response_ciphertext` LONGTEXT NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ef_idempotency_scope_uq` (`event_id`, `action`, `actor_scope`, `idempotency_key`),
  KEY `ef_idempotency_event_idx` (`event_id`)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
