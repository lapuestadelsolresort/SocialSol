'use strict';
//
// outreach-campaign.js — shared `outreach_campaigns` row helpers.
//
// Both batch.js and anniversary-cron.js use findOrCreateCampaign with the
// same shape; extracted here in R6 so the anniversary cron's stable-slug
// `'anniversary'` row matches the !batch path bit-for-bit.

const { sql } = require('@databases/sqlite');

/**
 * Look up an outreach_campaigns row by slug; create it if missing.
 *
 * @param {object} db                 - @databases/sqlite handle
 * @param {object} campaign           - the strategy-file config
 * @param {object} [opts]
 * @param {string} [opts.createdBy]   - audit string for created_by column
 * @returns {Promise<number>} campaign id
 */
async function findOrCreateCampaign(db, campaign, opts = {}) {
  const existing = await db.query(sql`
    SELECT id FROM outreach_campaigns WHERE slug = ${campaign.slug} LIMIT 1
  `);
  if (existing.length > 0) return existing[0].id;

  const personaBriefPath = `regina/library/campaigns/${campaign.slug}.json`;
  const description = campaign.description || campaign.name;
  const landing = campaign.landing_page_url || 'https://lapuestadelsolresort.com/';
  const createdBy = opts.createdBy || 'regina:r6_loader';

  await db.query(sql`
    INSERT INTO outreach_campaigns
      (name, slug, persona_brief_path, description, landing_page_url,
       campaign_kind, owning_agent, status, created_by, created_at)
    VALUES
      (${campaign.name}, ${campaign.slug}, ${personaBriefPath},
       ${description}, ${landing},
       ${campaign.campaign_kind}, ${campaign.owning_agent || 'regina'}, ${'active'}, ${createdBy},
       ${new Date().toISOString()})
  `);
  const [{ id }] = await db.query(sql`SELECT last_insert_rowid() AS id`);
  return id;
}

/**
 * Delete the campaign row if no outreach_sends reference it. Used to clean
 * up rows that were created speculatively before eligibility was confirmed.
 *
 * Caution: do NOT call this for the stable anniversary slug after a
 * non-empty fire — empty-day fires don't create a row in R6 (the fire
 * exits before findOrCreateCampaign), so this helper only fires when a
 * speculative row never landed any sends.
 */
async function deleteCampaignIfEmpty(db, campaignId) {
  const sends = await db.query(sql`
    SELECT COUNT(*) AS n FROM outreach_sends WHERE campaign_id = ${campaignId}
  `);
  if ((sends[0] || {}).n === 0) {
    await db.query(sql`DELETE FROM outreach_campaigns WHERE id = ${campaignId}`);
  }
}

module.exports = { findOrCreateCampaign, deleteCampaignIfEmpty };
