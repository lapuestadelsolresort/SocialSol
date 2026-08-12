# Workflow truth evals

`cases.json` is the committed, PII-free regression set for the most damaging
misleading-answer modes. CI runs the grader against the committed synthetic
fixture in `responses.fixture.json`; this is a grader contract test, not evidence
of live agent behavior. An architecture-only registry check is available
explicitly with `--architecture-only`, but does not count as a behavioral eval.
To score real captured agent responses, provide a private JSON file:

```json
[
  {
    "case_id": "whatsapp-provider-acceptance",
    "response": "Twilio reports queued; delivery and read are not confirmed.",
    "tool_calls": ["whatsapp.status.read"]
  }
]
```

Run `EVAL_RESPONSES_FILE=/private/path/responses.json npm run eval:workflows`.
The command fails when the private response file is not explicitly supplied.
Run it periodically against production-like captured responses outside public
CI. Never commit captured Slack text or guest/customer data.
