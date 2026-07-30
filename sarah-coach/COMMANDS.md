# Sarah Coach command reference

Sarah Coach turns a pasted inbound guest message into a suggested reply through
the Voice Service, then records whether the suggestion was sent as-is or edited.

```bash
node sarah-coach/scripts/coach.js
node sarah-coach/scripts/outcome.js
```

Exact payload formats are available with each script's usage output. Channel
and authorized-user identifiers live only in ignored
`sarah-coach/config.json`.
