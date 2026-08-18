-- Feedback closure eligibility — guests with private feedback who are
-- reachable via ANY channel.
--
-- The provenance test here is intentionally LOOSER than the global
-- contacts.addressable filter (which excludes airbnb_thread_only). Closure
-- messages can ship via the Airbnb thread because the provenance hard rule
-- in regina/lib/dossier-context.js (resolveSendMethod) routes
-- airbnb_thread_only contacts to send_method='manual_airbnb_thread' at
-- draft time. The eligibility filter therefore admits them; channel
-- selection happens via send_method, not exclusion.
--
-- R6 ships this as strategy-only: contacts.has_private_feedback is 0 for
-- all rows until a definition + backfill sub-task lands (R6.5+). Expect
-- 0 results until then.
SELECT c.id
FROM contacts c
WHERE c.has_private_feedback = 1
  AND ( c.email IS NOT NULL
        OR c.phone IS NOT NULL
        OR c.contact_provenance = 'airbnb_thread_only' )
  AND COALESCE(c.do_not_contact, 0) = 0
  AND EXISTS (
    SELECT 1 FROM guest_dossiers d, json_each(d.contact_ids) je
    WHERE je.value = c.id
      AND d.extraction_status = 'extracted'
      AND d.language = 'en'
  )
  AND NOT EXISTS (
    SELECT 1 FROM outreach_sends s
    INNER JOIN outreach_campaigns oc ON oc.id = s.campaign_id
    WHERE s.contact_id = c.id
      AND oc.campaign_kind = 'reactivation_feedback_closure'
      -- 'ambiguous' (provider may have accepted the send) and 'approved'
      -- (queued, not yet dispatched) also block re-selection — F-050.
      AND ( s.status IN ('sent', 'rejected', 'drafted', 'ambiguous', 'approved')
            OR (s.status = 'deferred' AND s.defer_until > date('now')) )
  )
ORDER BY c.last_stay_date DESC NULLS LAST
LIMIT :batch_size;
