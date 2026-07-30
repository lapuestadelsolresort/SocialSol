SELECT c.id
FROM contacts c
WHERE c.has_private_feedback = 1
  AND (c.email IS NOT NULL OR c.phone IS NOT NULL OR c.contact_provenance = 'airbnb_thread_only')
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
      AND (s.status IN ('sent', 'rejected', 'drafted')
           OR (s.status = 'deferred' AND s.defer_until > date('now')))
  )
ORDER BY c.last_stay_date DESC NULLS LAST
LIMIT :batch_size;
