# Reengager Regina

Regina reactivates past guests and prior qualified inquiries using the shared
CRM and Voice Service. Campaign definitions and eligibility SQL live under
`library/campaigns/`.

Email contacts can be sent through the same verified Resend/compliance pipeline
used by Prospector. WhatsApp and Airbnb-thread contacts remain manual.

Copy `config.example.json` to ignored `config.json`. The public default has
`auto_send.enabled` set to `false`; when disabled, eligible email drafts use the
`manual_email` path. Enabling it is an explicit production decision.
