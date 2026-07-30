SELECT c.id
FROM contacts c
WHERE c.relationship_type = 'past_guest_cancelled'
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
      AND oc.campaign_kind = 'reactivation_winback'
      AND (s.status IN ('sent', 'rejected', 'drafted')
           OR (s.status = 'deferred' AND s.defer_until > date('now')))
  )
LIMIT :batch_size;
