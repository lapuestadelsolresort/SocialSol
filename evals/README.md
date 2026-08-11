# Workflow truth evals

`cases.json` is the committed, PII-free regression set for the most damaging
misleading-answer modes. `npm run eval:workflows` verifies that each required
deterministic workflow exists. To score captured agent responses, provide a
private JSON file:

```json
[
  {
    "case_id": "whatsapp-provider-acceptance",
    "response": "Twilio reports queued; delivery and read are not confirmed.",
    "tool_calls": ["whatsapp.status.read"]
  }
]
```

Run `node evals/run.js --responses /private/path/responses.json`. Never commit
captured Slack text or guest/customer data.
