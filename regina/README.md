# Reengager Regina

Regina reactivates past guests and prior qualified inquiries using the shared
CRM and Voice Service. Campaign definitions and eligibility SQL live under
`library/campaigns/`.

Email contacts can be sent through the same verified Resend/compliance pipeline
used by Prospector. WhatsApp and Airbnb-thread contacts remain manual.

The daily `regina.daily` graph posts one summary without user `@mentions`. It
aggregates CRM-verified results from both scheduled anniversary work and any
`regina.campaign` runs since the prior completed daily summary. Individual
workflow-completion and routine batch-summary posts are suppressed. Actionable
manual-draft threads and immediate failure or skip alerts remain separate so
the recorded `!sent`, `!skip`, and `!defer` workflow continues to function;
successful auto-sends appear only in the aggregate summary.

Copy `config.example.json` to ignored `config.json`. The public default has
`auto_send.enabled` set to `false`; when disabled, eligible email drafts use the
`manual_email` path. Enabling it is an explicit production decision.
