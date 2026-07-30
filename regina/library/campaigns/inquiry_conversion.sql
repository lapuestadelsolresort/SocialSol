-- Inquiry conversion eligibility — past_guest_inquired with a dossier-named
-- addressable blocker. Confidence floor 0.6 keeps low-signal extractions
-- out of the pool. Refuses why_no_book='went_elsewhere' implicitly via the
-- IN-list (Project_Status.md:694, 748).
SELECT c.id
FROM contacts c
WHERE c.relationship_type = 'past_guest_inquired'
  AND COALESCE(c.do_not_contact, 0) = 0
  AND EXISTS (
    SELECT 1 FROM guest_dossiers d, json_each(d.contact_ids) je
    WHERE je.value = c.id
      AND d.extraction_status = 'extracted'
      AND d.language = 'en'
      AND d.why_no_book IN ('price', 'dates_unavailable', 'no_response')
      AND d.why_no_book_confidence >= 0.6
  )
  AND NOT EXISTS (
    SELECT 1 FROM outreach_sends s
    INNER JOIN outreach_campaigns oc ON oc.id = s.campaign_id
    WHERE s.contact_id = c.id
      AND oc.campaign_kind = 'reactivation_conversion'
      AND ( s.status IN ('sent', 'rejected', 'drafted')
            OR (s.status = 'deferred' AND s.defer_until > date('now')) )
  )
ORDER BY c.last_stay_date DESC NULLS LAST
LIMIT :batch_size;
