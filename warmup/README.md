# Sender warmup

`scripts/warmup-daily.sh` gradually warms the configured Resend sender using a
private allow-list and the committed message templates.

Before use:

```bash
cp warmup/recipients.example.json warmup/recipients.json
cp warmup/state.example.json warmup/state.json
```

Replace the example recipients only with people who have agreed to receive the
warmup messages. Recipient lists, send state, webhook events, and logs are
ignored.
