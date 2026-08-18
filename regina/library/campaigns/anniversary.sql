-- Anniversary eligibility — past_guest_stayed contacts whose last_stay_date
-- MM-DD matches :today. Annual cadence: NOT EXISTS uses created_at > -300d
-- (vs. the campaign_kind status-set used by other campaigns) so a contact
-- becomes eligible again the next year, with a 65-day buffer that protects
-- against re-firing the same calendar year if something goes wrong.
--
-- The campaign_kind = 'reactivation_anniversary' filter on the join is
-- essential — without it, an unrelated winback last month would block this
-- year's anniversary, which is wrong.
SELECT c.id
FROM contacts c
WHERE c.relationship_type = 'past_guest_stayed'
  AND c.last_stay_date IS NOT NULL
  AND strftime('%m-%d', c.last_stay_date) = strftime('%m-%d', :today)
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
      AND oc.campaign_kind = 'reactivation_anniversary'
      AND s.created_at > date('now', '-300 days')
      -- A row abandoned to a Resend rate limit was never delivered, so it must
      -- not consume this year's anniversary. auto-send retries in-run first;
      -- this keeps the contact selectable for a same-day re-run (F-050b).
      AND NOT (s.status = 'cancelled' AND s.error = 'resend_rate_limit')
  )
LIMIT :batch_size;
