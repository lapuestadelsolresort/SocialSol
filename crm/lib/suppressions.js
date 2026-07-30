/**
 * Suppressions library — single writer for the `suppressions` table and the
 * downstream `contacts.do_not_contact` cascade.
 *
 * Extracted from inline route handlers in server.js (POST /api/suppressions and
 * the three Resend webhook event branches: bounce / complaint / unsubscribed).
 * All five callers — the four pre-existing sites plus the new /unsubscribe
 * endpoint — now go through addSuppression() so the cascade rules live in one
 * place.
 *
 * Cascade scope:
 *   - cascadeContactId provided  → updates only that specific contacts row.
 *     Used by the Resend webhook handlers, which already know the exact
 *     contact_id from the matched outreach_sends row.
 *   - cascadeContactId omitted   → updates all contacts rows matching the
 *     normalized email. Used by /api/suppressions and /unsubscribe; preserves
 *     the email-global semantics those endpoints had pre-refactor.
 *
 * The cascade always runs, even when the suppression row already existed.
 * That matches the pre-refactor webhook behavior (idempotent re-assertion of
 * DNC) and is a no-op against already-DNC'd contacts.
 *
 * The /api/suppressions route still preserves its 409-on-duplicate HTTP
 * semantics by inspecting `alreadyExisted` in the return value before
 * deciding the response code.
 */

const { sql } = require('@databases/sqlite');

async function addSuppression(db, {
  email,
  reason,
  source = null,
  notes = null,
  addedBy = null,
  cascadeContactId = null,
}) {
  if (!email) throw new Error('addSuppression: email is required');
  if (!reason) throw new Error('addSuppression: reason is required');

  const normalizedEmail = String(email).toLowerCase().trim();
  const now = new Date().toISOString();

  const existing = await db.query(
    sql`SELECT id FROM suppressions WHERE email = ${normalizedEmail}`
  );
  const alreadyExisted = existing.length > 0;
  let suppressionId = alreadyExisted ? existing[0].id : null;

  if (!alreadyExisted) {
    await db.query(sql`
      INSERT INTO suppressions (email, reason, source, notes, added_by)
      VALUES (${normalizedEmail}, ${reason}, ${source}, ${notes}, ${addedBy})
    `);
    const [created] = await db.query(
      sql`SELECT id FROM suppressions WHERE email = ${normalizedEmail}`
    );
    suppressionId = created.id;
  }

  // Cascade DNC + reason + status to contacts. Bounce additionally marks
  // email_status='bounced' (matches pre-refactor webhook behavior; the
  // /api/suppressions endpoint pre-refactor did not set email_status, so
  // applying it here for that path is a deliberate convergence — the parity
  // diff will surface it as a bug-fix-grade change).
  if (cascadeContactId !== null && cascadeContactId !== undefined) {
    if (reason === 'bounce') {
      await db.query(sql`
        UPDATE contacts SET
          do_not_contact = 1,
          do_not_contact_reason = ${reason},
          email_status = 'bounced',
          status = 'dead',
          updated_at = ${now}
        WHERE id = ${cascadeContactId}
      `);
    } else {
      await db.query(sql`
        UPDATE contacts SET
          do_not_contact = 1,
          do_not_contact_reason = ${reason},
          status = 'dead',
          updated_at = ${now}
        WHERE id = ${cascadeContactId}
      `);
    }
  } else {
    if (reason === 'bounce') {
      await db.query(sql`
        UPDATE contacts SET
          do_not_contact = 1,
          do_not_contact_reason = ${reason},
          email_status = 'bounced',
          status = 'dead',
          updated_at = ${now}
        WHERE email = ${normalizedEmail}
      `);
    } else {
      await db.query(sql`
        UPDATE contacts SET
          do_not_contact = 1,
          do_not_contact_reason = ${reason},
          status = 'dead',
          updated_at = ${now}
        WHERE email = ${normalizedEmail}
      `);
    }
  }

  // Reason-specific timestamp cascade.
  const usesContactId = cascadeContactId !== null && cascadeContactId !== undefined;

  if (reason === 'bounce') {
    if (usesContactId) {
      await db.query(sql`UPDATE contacts SET bounced_at = ${now} WHERE id = ${cascadeContactId}`);
    } else {
      await db.query(sql`UPDATE contacts SET bounced_at = ${now} WHERE email = ${normalizedEmail}`);
    }
  } else if (reason === 'complaint') {
    if (usesContactId) {
      await db.query(sql`UPDATE contacts SET complained_at = ${now} WHERE id = ${cascadeContactId}`);
    } else {
      await db.query(sql`UPDATE contacts SET complained_at = ${now} WHERE email = ${normalizedEmail}`);
    }
  } else if (reason === 'unsubscribe_link') {
    if (usesContactId) {
      await db.query(sql`UPDATE contacts SET unsubscribed_at = ${now} WHERE id = ${cascadeContactId}`);
    } else {
      await db.query(sql`UPDATE contacts SET unsubscribed_at = ${now} WHERE email = ${normalizedEmail}`);
    }
  }

  return { inserted: !alreadyExisted, alreadyExisted, suppressionId, normalizedEmail };
}

module.exports = { addSuppression };
