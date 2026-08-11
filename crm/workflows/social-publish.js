'use strict';

const { sql } = require('@databases/sqlite');
const { createInstagramPost, listPosts } = require('../lib/postiz');

function validate(input) {
  if (!/^[0-9a-f-]{36}$/i.test(String(input.contentId || ''))) throw new Error('valid contentId is required');
  if (input.publishNow !== true && input.scheduledFor && Number.isNaN(new Date(input.scheduledFor).valueOf())) {
    throw new Error('scheduledFor must be an ISO date-time');
  }
}

function windowAround(iso) {
  const center = new Date(iso).getTime();
  return {
    startDate: new Date(center - 24 * 60 * 60_000).toISOString(),
    endDate: new Date(center + 24 * 60 * 60_000).toISOString(),
  };
}

function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function matchingPost(posts, { id = null, caption, scheduledFor }) {
  return posts.find(post => {
    if (id && String(post.id) === String(id)) return true;
    if (normalize(post.content) !== normalize(caption)) return false;
    const delta = Math.abs(new Date(post.publishDate).getTime() - new Date(scheduledFor).getTime());
    return Number.isFinite(delta) && delta <= 60_000;
  }) || null;
}

const definition = {
  name: 'social.content.publish',
  version: 1,
  capability: 'social.publish',
  mutates: true,
  validate,
  steps: [
    {
      key: 'resolve_content', maxAttempts: 1,
      async run({ db, input }) {
        const [row] = await db.query(sql`SELECT * FROM social_content WHERE id=${input.contentId}`);
        if (!row) throw new Error('social content not found');
        const mediaRefs = JSON.parse(row.media_refs_json || '[]');
        if (!mediaRefs.length || mediaRefs.some(ref => !ref.id || !ref.path)) {
          throw new Error('social content requires Postiz-uploaded media references with id and path');
        }
        const scheduledFor = input.publishNow === true
          ? new Date().toISOString()
          : input.scheduledFor || row.scheduled_for;
        if (!scheduledFor) throw new Error('scheduledFor is required unless publishNow=true');
        return {
          contentId: row.id,
          caption: row.caption,
          mediaRefs,
          scheduledFor: new Date(scheduledFor).toISOString(),
          publishNow: input.publishNow === true,
          existingPostId: row.postiz_post_id || null,
        };
      },
    },
    {
      key: 'register_effect', maxAttempts: 1,
      async run({ db, run, state, store, stepKey }) {
        const content = state.resolve_content;
        const effect = await store.createEffect(db, {
          runId: run.id, stepKey, effectType: 'social_publish', provider: 'postiz',
          operation: 'instagram.create_post', idempotencyKey: `${run.id}:postiz:instagram.create_post`,
          request: {
            contentId: content.contentId,
            captionHash: store.sha256(content.caption),
            mediaIds: content.mediaRefs.map(ref => ref.id),
            scheduledFor: content.scheduledFor,
            publishNow: content.publishNow,
          },
          target: { contentId: content.contentId },
        });
        return { effectId: effect.id };
      },
    },
    {
      key: 'create_or_recover', maxAttempts: 3,
      async run({ db, state, store }) {
        const content = state.resolve_content;
        const posts = await listPosts(windowAround(content.scheduledFor));
        let post = matchingPost(posts, {
          id: content.existingPostId,
          caption: content.caption,
          scheduledFor: content.scheduledFor,
        });
        let recovered = Boolean(post);
        if (!post) {
          const created = await createInstagramPost(content);
          post = { id: created.postId, publishDate: content.scheduledFor, content: content.caption };
          recovered = false;
        }
        await db.query(sql`UPDATE social_content SET postiz_post_id=${post.id},
          status=${content.publishNow ? 'publishing' : 'scheduled'},
          scheduled_for=${content.scheduledFor}, updated_at=datetime('now')
          WHERE id=${content.contentId}`);
        await store.transitionEffect(db, {
          effectId: state.register_effect.effectId,
          providerRef: String(post.id),
          status: 'accepted_by_provider',
          providerStatus: recovered ? 'recovered_by_preflight_readback' : 'post_created',
          response: { postId: post.id, publishDate: post.publishDate || content.scheduledFor },
        });
        return { postId: String(post.id), recovered };
      },
    },
    {
      key: 'verify_readback', maxAttempts: 4,
      async run({ db, run, state, store, stepKey }) {
        const content = state.resolve_content;
        const posts = await listPosts(windowAround(content.scheduledFor));
        const post = matchingPost(posts, {
          id: state.create_or_recover.postId,
          caption: content.caption,
          scheduledFor: content.scheduledFor,
        });
        if (!post) {
          const error = new Error('Postiz post is not yet visible in provider readback');
          error.retryable = true;
          throw error;
        }
        const evidence = await store.createEvidence(db, {
          runId: run.id, stepKey, source: 'postiz.posts.list', sourceRef: String(post.id), payload: post,
        });
        await store.transitionEffect(db, {
          effectId: state.register_effect.effectId,
          status: 'verified_by_readback',
          providerStatus: content.publishNow ? 'publish_request_verified' : 'schedule_verified',
          response: { postId: post.id, evidenceId: evidence.id },
        });
        await db.query(sql`UPDATE social_content SET status=${content.publishNow ? 'publishing' : 'scheduled'},
          updated_at=datetime('now') WHERE id=${content.contentId}`);
        return { postId: String(post.id), evidenceId: evidence.id, scheduledFor: content.scheduledFor };
      },
    },
  ],
  output({ state }) {
    return { ...state.verify_readback, effectId: state.register_effect.effectId, status: 'verified_by_readback' };
  },
};

module.exports = { definition, matchingPost, normalize, validate, windowAround };
