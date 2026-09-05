-- ============================================================================
-- Collapse the staff hierarchy to three roles.
--
-- The catalogue used to carry seven roles. Four of them were staff jobs —
-- admin, finance manager, store manager, team manager — and in practice nobody
-- could say where one stopped and the next began. Every argument about "can
-- this person do X" turned into an argument about which of two middle tiers
-- they belonged to.
--
-- What is left is the distinction that actually matters at an event: you own
-- the system (super admin), you run the event (admin), or you work a till
-- (cashier). PARTICIPANT stays, but it is not a job — it is what every
-- attendee holds from the moment they are enrolled.
--
-- Existing grants are carried across rather than dropped, because `user_roles`
-- is referenced by the audit trail and because revoking someone's access as a
-- side effect of a deploy is how an event stops mid-service:
--
--   FINANCE_MANAGER -> ADMIN    Top-ups, adjustments and approvals live
--                               nowhere else now, so finance work is admin
--                               work. ADMIN is a strict superset; nobody
--                               loses an ability.
--
--   STORE_MANAGER   -> CASHIER  Deliberately the safer direction. A store
--                               manager could edit prices and stock; a cashier
--                               cannot. Handing them ADMIN instead would also
--                               hand them the power to mint points, which is
--                               not a privilege to grant as a migration side
--                               effect. Promote the ones who need it.
--
--   TEAM_MANAGER    -> dropped  Never held by anyone.
-- ============================================================================

-- Carry the grants over first: `user_roles.role_id` is ON DELETE RESTRICT, so
-- the role rows below cannot disappear while anyone still holds them.
INSERT INTO user_roles (user_id, role_id, event_id, store_id, granted_by)
SELECT held.user_id, target.id, held.event_id, held.store_id, held.granted_by
  FROM user_roles held
  JOIN roles retired ON retired.id = held.role_id
  JOIN roles target
    ON target.key = CASE retired.key
                      WHEN 'FINANCE_MANAGER' THEN 'ADMIN'
                      WHEN 'STORE_MANAGER'   THEN 'CASHIER'
                    END
 WHERE retired.key IN ('FINANCE_MANAGER', 'STORE_MANAGER')
-- Someone who already holds the destination role at the same scope.
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DELETE FROM user_roles held
 USING roles retired
 WHERE retired.id = held.role_id
   AND retired.key IN ('FINANCE_MANAGER', 'STORE_MANAGER', 'TEAM_MANAGER');
--> statement-breakpoint

DELETE FROM role_permissions granted
 USING roles retired
 WHERE retired.id = granted.role_id
   AND retired.key IN ('FINANCE_MANAGER', 'STORE_MANAGER', 'TEAM_MANAGER');
--> statement-breakpoint

DELETE FROM roles
 WHERE key IN ('FINANCE_MANAGER', 'STORE_MANAGER', 'TEAM_MANAGER');
