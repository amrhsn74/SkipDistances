-- A `client_approver` User may hold exactly one ClientAssignment row, ever.
--
-- The model-level @@unique([client_id, user_id, role_on_client]) does not say
-- this: it permits the same contact to be approver on CL-101 AND CL-102,
-- because those rows differ by client_id. That is the cross-client hole this
-- invariant exists to close -- one client's contact must never gain approval
-- rights over another client's content.
--
-- Prisma's schema language cannot express a partial (filtered) unique index, so
-- it is declared here in raw SQL. lib/domain/clientContactInvariant.ts enforces
-- the same rule with a readable error; this index is the backstop that makes a
-- direct insert fail too.
--
-- Staff roles are deliberately NOT covered: content_lead and content_creator are
-- many-to-many with Client by design.
CREATE UNIQUE INDEX "ClientAssignment_single_client_approver"
    ON "ClientAssignment" ("user_id")
    WHERE "role_on_client" = 'client_approver';
