/**
 * Prospector Paulina dispatcher plugin
 *
 * Registers two surfaces:
 *
 *   1. Slack interactive handler (namespace `paulina`)
 *      Catches Block Kit button clicks (`paulina:approve:<id>`,
 *      `paulina:reject_modal:<id>`, `paulina:edit_modal:<id>`,
 *      `paulina:reply_hot:<contact_id>`, etc.) and view_submission events
 *      (callback_id `paulina:reject_submit:<id>`, `paulina:edit_submit:<id>`).
 *      Routes each action to the corresponding CRM endpoint (Phase A).
 *
 *   2. HTTP route POST /paulina/post-draft
 *      The composer (Step 3.2 Phase B) POSTs `{ channel_id, blocks, fallback_text }`
 *      to render a Block Kit draft with `action_id`s in the `paulina:` namespace.
 *      The plugin uses Bolt's `app.client.chat.postMessage` and returns the
 *      Slack `ts` for the composer to persist on `outreach_sends.slack_message_ts`.
 *
 * Status (2026-05-06): scaffolded. v0 of Step 3.2 ships Pathway B (text
 * commands `!approve <id>` / `!reject <id> <reason>` via Sol's COMMANDS.md
 * playbook). Pathway A (interactive buttons) requires this plugin to be
 * installed; install via `openclaw plugins install <local-path>` once the
 * plugin is finalized.
 *
 * What still needs to happen before this plugin is production-ready:
 *   - Resolve how to invoke `app.client.chat.postMessage` from the HTTP route
 *     handler (the plugin SDK exposes this differently than the inbound
 *     interactive `respond` helper). Likely path: use a channel-plugin
 *     companion (`defineChannelPluginEntry`) OR call OpenClaw's outbound
 *     message API exposed via the plugin runtime.
 *   - Verify the plugin actually loads in this OpenClaw build — the
 *     `openclaw plugins install <local-path>` flow may require the plugin
 *     to be a git URL or registry entry rather than a bare directory.
 *   - Add tests (interactive payload fixtures, modal submission shapes).
 *
 * The piece that IS code-complete here is the action-id parsing and the
 * CRM-endpoint-routing logic in `lib/routes.js` — that's the part with
 * actual business logic. The Slack-side wiring (registerPluginInteractive
 * Handler call, view-submission shape, modal blocks) is sketched but
 * needs runtime validation against this OpenClaw version.
 */

'use strict';

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { registerPluginInteractiveHandler } from 'openclaw/plugin-sdk/plugin-runtime';
import { registerPluginHttpRoute } from 'openclaw/plugin-sdk/webhook-targets';
import { dispatchAction } from './lib/routes.js';
import { buildRejectModal, buildEditModal, buildApprovedStatusBlocks, buildRejectedStatusBlocks } from './lib/slack-update.js';

const PLUGIN_ID = 'paulina';

export default definePluginEntry({
  id: PLUGIN_ID,
  name: 'Prospector Paulina dispatcher',
  description: 'Block Kit interactions for #prospector-paulina drafts',

  register(api) {
    const config = api.getConfig?.() ?? {};
    const crmBaseUrl = config.crm_base_url || process.env.PAULINA_CRM_BASE_URL || 'http://localhost:3456';

    // ── Interactive handler ─────────────────────────────────────────────
    registerPluginInteractiveHandler(PLUGIN_ID, {
      channel: 'slack',
      namespace: PLUGIN_ID,
      async invoke({ interaction, respond }) {
        // interaction.payload is the raw Slack block_actions / view_submission
        // envelope. interaction.data is the action_id (or callback_id for view_submission)
        // already validated to start with `paulina:`. We dispatch on it.
        const result = await dispatchAction({
          data: interaction.data,
          payload: interaction.payload,
          crmBaseUrl,
        });
        if (result.kind === 'open_modal') {
          await respond.acknowledge?.();
          // views.open via the plugin's Slack client
          // TODO: figure out the SDK seam for views.open from a non-channel plugin
          //       (channel plugins have direct app.client access; this is a
          //       tool-plugin shape so the seam is different)
          return { handled: true };
        }
        if (result.kind === 'update_message') {
          await respond.editMessage?.({ blocks: result.blocks, text: result.fallback });
          await respond.followUp?.({ text: result.threadReply });
          return { handled: true };
        }
        if (result.kind === 'error') {
          await respond.acknowledge?.();
          await respond.reply?.({ text: result.message, ephemeral: true });
          return { handled: true };
        }
        await respond.acknowledge?.();
        return { handled: true };
      },
    }, { pluginName: 'Prospector Paulina dispatcher', pluginRoot: import.meta.url });

    // ── HTTP route: POST /paulina/post-draft ────────────────────────────
    registerPluginHttpRoute(PLUGIN_ID, {
      method: 'POST',
      path: '/paulina/post-draft',
      async handler(req, res) {
        // The composer POSTs { channel_id, blocks, fallback_text } here.
        // We use the plugin's Slack client to chat.postMessage with the
        // raw Block Kit blocks (action_ids in paulina: namespace), then
        // return the message ts so the composer can persist it.
        // TODO: wire the actual chat.postMessage call once the SDK seam is
        //       confirmed. Returning 501 until then so the composer falls
        //       back to its Pathway B path.
        res.statusCode = 501;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          error: 'plugin_not_finalized',
          detail: 'Phase D plugin scaffolded but not yet wired to chat.postMessage. Composer is using Pathway B (text-command draft post). See README.md.',
        }));
      },
    });
  },
});
