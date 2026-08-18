-- Referral mining eligibility — 5-star reviewers, ordered by recency of stay.
-- Already-contacted filter excludes contacts in any of:
--   sent / rejected / drafted under reactivation_referral, or
--   deferred under reactivation_referral with defer_until still in the future.
SELECT c.id
FROM contacts c
WHERE c.review_rating = 5
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
      AND oc.campaign_kind = 'reactivation_referral'
      -- 'ambiguous' (provider may have accepted the send) and 'approved'
      -- (queued, not yet dispatched) also block re-selection — F-050.
      AND ( s.status IN ('sent', 'rejected', 'drafted', 'ambiguous', 'approved')
            OR (s.status = 'deferred' AND s.defer_until > date('now')) )
  )
ORDER BY c.last_stay_date DESC
LIMIT :batch_size;
