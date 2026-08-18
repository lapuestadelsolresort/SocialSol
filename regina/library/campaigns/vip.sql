-- VIP eligibility — repeat guests (>=2 reservations).
-- R6 ships this as strategy-only: contacts.reservation_count is 0 for all
-- rows until a backfill sub-task lands (R6.5+). Expect 0 results until then.
SELECT c.id
FROM contacts c
WHERE c.reservation_count >= 2
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
      AND oc.campaign_kind = 'reactivation_vip'
      -- 'ambiguous' (provider may have accepted the send) and 'approved'
      -- (queued, not yet dispatched) also block re-selection — F-050.
      AND ( s.status IN ('sent', 'rejected', 'drafted', 'ambiguous', 'approved')
            OR (s.status = 'deferred' AND s.defer_until > date('now')) )
  )
ORDER BY c.reservation_count DESC, c.last_stay_date DESC
LIMIT :batch_size;
