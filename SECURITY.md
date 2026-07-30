# Security policy

## Reporting

Do not open a public issue containing a vulnerability, customer record, token, webhook secret, or recovery code. Contact the repository owners privately through GitHub organization administration.

## Credential policy

- Never commit `.env`, `secrets/`, databases, logs, campaign state, or cloud credentials.
- Production secrets must be stored outside the repository with filesystem mode `600`.
- Rotate any credential that appears in chat, logs, screenshots, commits, or pull requests.
- Keep webhook signature verification fail-closed when a signing secret is absent.

## Before every push

Run:

```bash
npm run check:secrets
npm audit --omit=dev
npm test
npm run build:landing
git diff --check
```
