/** DISTINCT requires every ORDER BY expression in SELECT on production MySQL. */
export const SESSION_EVENTS_SQL =
  "SELECT DISTINCT e.id,e.tenant_id,e.owner_user_id,e.event_state,e.updated_at,m.role AS member_role,m.merchant_id FROM ef_events e JOIN ef_organizations o ON o.id = e.tenant_id AND o.owner_user_id IS NOT NULL LEFT JOIN ef_members m ON m.event_id = e.id AND m.user_id = ? AND m.active = 1 WHERE (e.owner_user_id = ? OR m.user_id = ?) AND e.owner_user_id IS NOT NULL ORDER BY e.updated_at DESC";
