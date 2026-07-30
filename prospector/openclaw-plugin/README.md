# Paulina dispatcher — OpenClaw plugin (scaffolded)

This plugin adds Pathway A (interactive Block Kit buttons) to the prospector
draft-review workflow. Pathway B (text commands `!approve <id>` / `!reject
<id> <reason>`) is what ships in v0 of Step 3.2 via Sol's `COMMANDS.md`
playbook — the plugin is a follow-up that replaces the text commands with
buttons + modals.

## Status

**Scaffolded — not yet installed.** As of 2026-05-06, the action-id parsing,
the CRM endpoint routing (`lib/routes.js`), and the Block Kit builders
(`lib/slack-update.js`) are code-complete. The `index.js` entry point sketches
the Slack-side wiring (`registerPluginInteractiveHandler` + `registerPluginHttpRoute`)
but two seams need runtime validation before the plugin is production-ready:

1. **`views.open` from a non-channel plugin's invoke handler.** The plugin
   SDK exposes `respond.acknowledge` / `respond.reply` / `respond.editMessage`
   but not a direct `views.open`. The reject/edit modal flow needs the right
   SDK seam — likely a thin wrapper that uses the channel plugin's
   `app.client` directly.
2. **`chat.postMessage` from the HTTP route handler.** The composer (Phase B)
   wants to POST `{channel_id, blocks}` and receive `{ts}` back so it can
   persist `slack_message_ts`. The HTTP route handler returns 501 today; once
   the SDK seam is found this will use Bolt's outbound API.

## Structure

```
openclaw-plugin/
├── package.json              — npm metadata + `openclaw` build hints
├── openclaw.plugin.json      — manifest (id: 'paulina', config schema)
├── index.js                  — entry point. Calls definePluginEntry +
│                                registerPluginInteractiveHandler +
│                                registerPluginHttpRoute. Wired but stubbed
│                                where SDK seams aren't yet known.
├── lib/
│   ├── routes.js             — action_id → CRM endpoint dispatch (pure JS)
│   └── slack-update.js       — Block Kit builders for status lines + modals
└── README.md                 — this file
```

## Action_id naming convention

All action_ids and callback_ids use `paulina:<action>:<id>`:

| Surface | action_id / callback_id |
|---|---|
| Approve button on a draft post | `paulina:approve:<draft_id>` |
| Reject button (opens modal) | `paulina:reject_modal:<draft_id>` |
| Reject modal submit | `paulina:reject_submit:<draft_id>` (callback_id) |
| Edit button (opens modal) | `paulina:edit_modal:<draft_id>` |
| Edit modal submit | `paulina:edit_submit:<draft_id>` (callback_id) |
| Reply: Mark hot | `paulina:reply_hot:<contact_id>` |
| Reply: Mark not interested | `paulina:reply_not_interested:<contact_id>` |
| Reply: Mark needs Sarah | `paulina:reply_needs_sarah:<contact_id>` |

The OpenClaw plugin runtime's `resolveNamespaceMatch` (`plugin-runtime-UqZYCyH_.js:67`)
splits on `:` and matches the first segment against registered namespaces.
With `namespace: 'paulina'`, all of the above route to this plugin.

## CRM endpoints used (Phase A — already shipped)

| Action | CRM endpoint | Body |
|---|---|---|
| Approve | `POST /api/drafts/:id/approve` | `{by}` |
| Reject submit | `POST /api/drafts/:id/reject` | `{reason, by}` |
| Edit submit | `POST /api/drafts/:id/edit` | `{subject, body, by}` |
| Reply classify | `POST /api/contacts/:id/reply-classify` | `{quality, by}` |

The plugin is a thin adapter — all business logic (state machine, gate, edit
override logging) lives in those endpoints. Tests on those endpoints don't
need Slack at all.

## To finalize the plugin

1. **Confirm SDK seams** for `views.open` and `chat.postMessage` from a tool-
   plugin shape (this isn't a channel plugin). Read `openclaw/docs/plugins/
   sdk-overview.md` for the full registration API.
2. **Adjust the entry-point shape** if needed (`definePluginEntry` vs.
   `defineChannelPluginEntry`). The current scaffold uses the former — if it
   turns out we need channel-plugin access for outbound posts, switch.
3. **Wire `chat.postMessage` in the `/paulina/post-draft` route** so the
   composer can render Pathway A.
4. **Update `composer.js`** to POST to `/paulina/post-draft` instead of using
   the text-command Pathway B. (One-line change in `composer.js` —
   `postToSlack()` becomes `fetch(crmBaseUrl + '/paulina/post-draft', ...)`.)
5. **Install the plugin**:
   ```bash
   openclaw plugins install "$SOCIALSOL_ROOT/prospector/openclaw-plugin"
   ```
   (or whatever path-install syntax this OpenClaw version supports)
6. **Restart the OpenClaw gateway** so it loads the plugin.
7. **Smoke test**: run `!compose-batch planner_outreach_v1 1`, click the
   Approve button on the resulting draft, verify the row flips to `approved`
   in the CRM and the Slack message status updates.

## Why ship Pathway B first

Sarah and Jason can review and approve drafts today via `!approve <id>` /
`!reject <id> <reason>`. The Block Kit polish is a UX improvement, not a
new capability — and it's much faster to validate the composer + CRM
endpoints with text commands before adding the Slack interactive surface.
