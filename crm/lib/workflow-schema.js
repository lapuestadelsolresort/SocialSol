'use strict';

// Durable control-plane schema. Business records remain in their existing
// domain tables; these tables record orchestration state, evidence, effects,
// retries, and notifications without treating an LLM context window as state.

const EMAIL_REPLY_PROPOSALS_CREATE = `CREATE TABLE IF NOT EXISTS email_reply_proposals (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'gmail',
  outreach_send_id INTEGER REFERENCES outreach_sends(id),
  contact_id INTEGER REFERENCES contacts(id),
  inbound_email_thread_id INTEGER NOT NULL REFERENCES email_threads(id),
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  acceptance_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_by TEXT NOT NULL,
  confirmed_by TEXT,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  proposal_run_id TEXT REFERENCES workflow_runs(id),
  confirmation_run_id TEXT REFERENCES workflow_runs(id),
  provider_message_id TEXT,
  provider_thread_id TEXT,
  workflow_effect_id TEXT REFERENCES workflow_effects(id),
  processing_error TEXT,
  expires_at TEXT,
  confirmed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_name TEXT NOT NULL,
    workflow_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'created',
    trigger_type TEXT NOT NULL,
    trigger_ref TEXT,
    channel_id TEXT,
    actor_user_id TEXT,
    input_json TEXT NOT NULL,
    input_hash TEXT,
    policy_snapshot_json TEXT,
    policy_snapshot_hash TEXT,
    serialization_key TEXT,
    state_json TEXT NOT NULL DEFAULT '{}',
    output_json TEXT,
    current_step TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    available_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_owner TEXT,
    lease_token TEXT,
    lease_version INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    input_json TEXT,
    output_json TEXT,
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    UNIQUE(run_id, step_key)
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_key TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT,
    payload_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_effects (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_key TEXT,
    effect_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    provider_ref TEXT,
    request_hash TEXT NOT NULL,
    request_json TEXT,
    status TEXT NOT NULL DEFAULT 'requested',
    verification_mode TEXT NOT NULL DEFAULT 'readback_required',
    verification_deadline_at TEXT,
    provider_status TEXT,
    response_json TEXT,
    target_json TEXT,
    error_code TEXT,
    error_message TEXT,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    accepted_at TEXT,
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    verified_at TEXT,
    failed_at TEXT,
    manual_review_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_key TEXT,
    source TEXT NOT NULL,
    source_ref TEXT,
    observed_at TEXT NOT NULL,
    expires_at TEXT,
    confidence REAL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_outbox (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 12,
    available_at TEXT NOT NULL DEFAULT (datetime('now')),
    lease_owner TEXT,
    lease_token TEXT,
    lease_version INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS workflow_manual_reviews (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    step_key TEXT,
    effect_id TEXT REFERENCES workflow_effects(id) ON DELETE SET NULL,
    review_channel_id TEXT,
    reason_code TEXT NOT NULL,
    reason_message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    resolution_provider_ref TEXT,
    resolved_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    UNIQUE(run_id, step_key, reason_code)
  )`,
  `CREATE TABLE IF NOT EXISTS accounting_receipts (
    id TEXT PRIMARY KEY,
    slack_channel_id TEXT NOT NULL,
    slack_message_id TEXT NOT NULL,
    slack_thread_ts TEXT,
    submitted_by TEXT,
    submitted_at TEXT NOT NULL,
    message_text TEXT,
    file_refs_json TEXT NOT NULL DEFAULT '[]',
    source_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',
    vendor TEXT,
    transaction_date TEXT,
    currency TEXT,
    amount REAL,
    transaction_kind TEXT,
    description TEXT,
    category_key TEXT,
    category_name TEXT,
    extraction_confidence REAL,
    review_reason TEXT,
    amount_usd REAL,
    fx_rate REAL,
    qbo_entity_type TEXT,
    qbo_entity_id TEXT,
    qbo_request_id TEXT,
    posted_at TEXT,
    payment_reference TEXT,
    reimbursement_recipient_user_id TEXT,
    payment_source TEXT,
    payment_source_selected_by TEXT,
    payment_source_selected_at TEXT,
    payment_source_workflow_run_id TEXT REFERENCES workflow_runs(id),
    payment_instruction_hash TEXT,
    payment_instruction_queued_at TEXT,
    extraction_json TEXT,
    workflow_run_id TEXT REFERENCES workflow_runs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(slack_channel_id, slack_message_id)
  )`,
  `CREATE TABLE IF NOT EXISTS accounting_receipt_items (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES accounting_receipts(id) ON DELETE CASCADE,
    item_index INTEGER NOT NULL,
    file_ref_id TEXT,
    vendor TEXT,
    transaction_date TEXT,
    currency TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    category_key TEXT,
    category_name TEXT,
    extraction_confidence REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(receipt_id, item_index)
  )`,
  `CREATE TABLE IF NOT EXISTS accounting_reconciliations (
    id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES accounting_receipts(id),
    bank_provider TEXT NOT NULL DEFAULT 'kapital',
    bank_reference TEXT,
    qbo_entity_type TEXT,
    qbo_entity_id TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    confidence REAL,
    evidence_json TEXT NOT NULL DEFAULT '{}',
    workflow_run_id TEXT REFERENCES workflow_runs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(receipt_id, bank_provider, bank_reference)
  )`,
  `CREATE TABLE IF NOT EXISTS accounting_bank_transactions (
    id TEXT PRIMARY KEY,
    source_provider TEXT NOT NULL DEFAULT 'kapital',
    source_key TEXT NOT NULL UNIQUE,
    transaction_date TEXT,
    description TEXT,
    reference TEXT,
    direction TEXT,
    source_time TEXT,
    source_operation TEXT,
    source_transaction_code TEXT,
    currency TEXT NOT NULL DEFAULT 'MXN',
    amount REAL NOT NULL,
    amount_usd REAL,
    category_key TEXT,
    category_name TEXT,
    classification_tier TEXT NOT NULL,
    classification_reason TEXT,
    source_file_hash TEXT NOT NULL,
    workflow_run_id TEXT REFERENCES workflow_runs(id),
    qbo_workflow_run_id TEXT REFERENCES workflow_runs(id),
    qbo_entity_type TEXT,
    qbo_entity_id TEXT,
    qbo_request_id TEXT,
    qbo_category_key TEXT,
    qbo_category_name TEXT,
    qbo_recorded_at TEXT,
    review_required INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'classified',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS social_content (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    platform TEXT NOT NULL DEFAULT 'instagram',
    content_type TEXT NOT NULL DEFAULT 'post',
    caption TEXT NOT NULL,
    media_refs_json TEXT NOT NULL DEFAULT '[]',
    scheduled_for TEXT,
    postiz_post_id TEXT,
    created_by TEXT,
    updated_by TEXT,
    workflow_run_id TEXT REFERENCES workflow_runs(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS email_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    contact_id INTEGER REFERENCES contacts(id),
    crm_lead_id INTEGER REFERENCES leads(id),
    outreach_send_id INTEGER REFERENCES outreach_sends(id),
    direction TEXT NOT NULL,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    resend_email_id TEXT,
    from_address TEXT,
    sender_name TEXT,
    to_address TEXT,
    received_at TEXT,
    sentiment TEXT,
    sentiment_notes TEXT,
    forwarded_to TEXT,
    provider TEXT NOT NULL DEFAULT 'gmail',
    provider_message_id TEXT,
    provider_thread_id TEXT,
    provider_metadata_json TEXT,
    rfc_message_id TEXT,
    in_reply_to TEXT,
    references_header TEXT,
    raw_body_text TEXT,
    actor_user_id TEXT,
    classification_source TEXT,
    classified_at TEXT,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    processing_error TEXT,
    processed_at TEXT,
    slack_channel_id TEXT,
    slack_thread_ts TEXT,
    slack_message_ts TEXT,
    workflow_run_id TEXT REFERENCES workflow_runs(id),
    workflow_effect_id TEXT REFERENCES workflow_effects(id)
  )`,
  EMAIL_REPLY_PROPOSALS_CREATE,
  `CREATE TABLE IF NOT EXISTS processed_gmail_replies (
    message_id TEXT PRIMARY KEY,
    forwarded_at TEXT NOT NULL,
    send_id INTEGER,
    matched INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ownerrez_mutation_proposals (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    method TEXT NOT NULL,
    request_path TEXT NOT NULL,
    path_params_json TEXT NOT NULL DEFAULT '{}',
    query_json TEXT NOT NULL DEFAULT '{}',
    body_json TEXT,
    reason TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    acceptance_hash TEXT NOT NULL,
    before_json TEXT,
    before_hash TEXT,
    before_etag TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    proposed_by TEXT NOT NULL,
    confirmed_by TEXT,
    proposal_run_id TEXT REFERENCES workflow_runs(id),
    confirmation_run_id TEXT REFERENCES workflow_runs(id),
    provider_ref TEXT,
    provider_status TEXT,
    response_json TEXT,
    readback_json TEXT,
    readback_hash TEXT,
    processing_error TEXT,
    expires_at TEXT NOT NULL,
    confirmed_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS marketing_change_requests (
    id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    scope_ref TEXT NOT NULL,
    authority_tier TEXT NOT NULL,
    request_json TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    acceptance_hash TEXT,
    preflight_json TEXT NOT NULL,
    preflight_hash TEXT NOT NULL,
    source_evidence_id TEXT REFERENCES workflow_evidence(id),
    status TEXT NOT NULL DEFAULT 'pending',
    reason TEXT NOT NULL,
    proposed_by TEXT NOT NULL,
    confirmed_by TEXT,
    proposal_run_id TEXT REFERENCES workflow_runs(id),
    execution_run_id TEXT REFERENCES workflow_runs(id),
    effect_id TEXT REFERENCES workflow_effects(id),
    provider_ref TEXT,
    readback_evidence_id TEXT REFERENCES workflow_evidence(id),
    processing_error TEXT,
    expires_at TEXT,
    confirmed_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS marketing_audience_state (
    audience_key TEXT PRIMARY KEY,
    audience_id TEXT NOT NULL,
    audience_name TEXT NOT NULL,
    email_count INTEGER NOT NULL DEFAULT 0,
    hashed_emails_json TEXT NOT NULL DEFAULT '[]',
    provider_readback_json TEXT,
    last_workflow_run_id TEXT REFERENCES workflow_runs(id),
    last_synced_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS marketing_campaign_registry (
    registry_key TEXT PRIMARY KEY,
    records_json TEXT NOT NULL,
    records_hash TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    source_path TEXT NOT NULL,
    last_workflow_run_id TEXT,
    observed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS ownerrez_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT,
    received_at TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0,
    processed_at TEXT,
    processing_status TEXT,
    workflow_run_id TEXT REFERENCES workflow_runs(id),
    processing_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_runs_channel ON workflow_runs(channel_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_steps_due ON workflow_steps(status, available_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_events_run ON workflow_events(run_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_effects_run ON workflow_effects(run_id, requested_at)`,
  `DROP INDEX IF EXISTS idx_workflow_effects_provider_ref`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_effects_provider_ref
     ON workflow_effects(provider, provider_ref) WHERE provider_ref IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_effects_status ON workflow_effects(provider, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_evidence_run ON workflow_evidence(run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_outbox_due ON workflow_outbox(status, available_at)`,
  `CREATE INDEX IF NOT EXISTS idx_workflow_manual_reviews_status
     ON workflow_manual_reviews(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_receipts_status ON accounting_receipts(status, submitted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_receipt_items_receipt
     ON accounting_receipt_items(receipt_id, item_index)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_receipt_items_category
     ON accounting_receipt_items(category_key, transaction_date)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_reconciliations_status ON accounting_reconciliations(status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_accounting_bank_txn_match ON accounting_bank_transactions(transaction_date, amount, currency)`,
  `CREATE INDEX IF NOT EXISTS idx_social_content_status ON social_content(status, scheduled_for)`,
  `CREATE INDEX IF NOT EXISTS idx_email_threads_contact ON email_threads(contact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_email_threads_received ON email_threads(received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_email_reply_proposals_status
     ON email_reply_proposals(status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pgr_forwarded_at ON processed_gmail_replies(forwarded_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ownerrez_proposals_status
     ON ownerrez_mutation_proposals(status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_marketing_change_status
     ON marketing_change_requests(status, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_marketing_change_target
     ON marketing_change_requests(scope_ref, created_at)`,
];

const META_MESSAGE_COLUMNS = [
  'slack_thread_ts TEXT',
  'direction TEXT',
  'delivery_status TEXT',
  'provider_delivery_status TEXT',
  'provider_error_code TEXT',
  'provider_error_message TEXT',
  'delivery_status_source TEXT',
  'provider_status_updated_at TEXT',
  'delivered_at TEXT',
  'read_at TEXT',
  'failed_at TEXT',
  'workflow_run_id TEXT',
  'workflow_effect_id TEXT',
  'processing_status TEXT',
  'processing_error TEXT',
  'processed_at TEXT',
  'crm_lead_id INTEGER',
  'lead_created INTEGER NOT NULL DEFAULT 0',
  'attribution_method TEXT',
];

const OWNERREZ_EVENT_COLUMNS = [
  'payload_hash TEXT',
  'processing_status TEXT',
  'workflow_run_id TEXT',
  'processing_error TEXT',
];

const OUTREACH_SEND_COLUMNS = [
  'workflow_run_id TEXT',
];

const EMAIL_THREAD_COLUMNS = [
  'crm_lead_id INTEGER',
  "provider TEXT NOT NULL DEFAULT 'gmail'",
  'provider_message_id TEXT',
  'provider_thread_id TEXT',
  'provider_metadata_json TEXT',
  'rfc_message_id TEXT',
  'in_reply_to TEXT',
  'references_header TEXT',
  'raw_body_text TEXT',
  'actor_user_id TEXT',
  'classification_source TEXT',
  'classified_at TEXT',
  "processing_status TEXT NOT NULL DEFAULT 'pending'",
  'processing_error TEXT',
  'processed_at TEXT',
  'sender_name TEXT',
  'slack_channel_id TEXT',
  'slack_thread_ts TEXT',
  'slack_message_ts TEXT',
  'workflow_run_id TEXT',
  'workflow_effect_id TEXT',
];

const EMAIL_REPLY_PROPOSAL_COLUMNS = [
  "provider TEXT NOT NULL DEFAULT 'gmail'",
];

const EMAIL_REPLY_PROPOSAL_COPY_COLUMNS = [
  'id', 'outreach_send_id', 'contact_id', 'inbound_email_thread_id',
  'to_address', 'subject', 'body_text', 'request_hash', 'acceptance_hash',
  'status', 'proposed_by', 'confirmed_by', 'slack_channel_id',
  'slack_thread_ts', 'proposal_run_id', 'confirmation_run_id',
  'provider_message_id', 'provider_thread_id', 'workflow_effect_id',
  'processing_error', 'expires_at', 'confirmed_at', 'completed_at',
  'created_at', 'updated_at',
];

const WORKFLOW_RUN_COLUMNS = [
  'input_hash TEXT',
  'policy_snapshot_json TEXT',
  'policy_snapshot_hash TEXT',
  'serialization_key TEXT',
];

const WORKFLOW_STEP_COLUMNS = [
  'lease_token TEXT',
  'lease_version INTEGER NOT NULL DEFAULT 0',
];

const WORKFLOW_EFFECT_COLUMNS = [
  'manual_review_at TEXT',
  "verification_mode TEXT NOT NULL DEFAULT 'readback_required'",
  'verification_deadline_at TEXT',
];

const WORKFLOW_MANUAL_REVIEW_COLUMNS = [
  'resolution_provider_ref TEXT',
  'review_channel_id TEXT',
];

const WORKFLOW_OUTBOX_COLUMNS = [
  'lease_token TEXT',
  'lease_version INTEGER NOT NULL DEFAULT 0',
];

const ACCOUNTING_RECEIPT_COLUMNS = [
  'transaction_kind TEXT',
  'description TEXT',
  'category_key TEXT',
  'category_name TEXT',
  'extraction_confidence REAL',
  'review_reason TEXT',
  'amount_usd REAL',
  'fx_rate REAL',
  'qbo_entity_type TEXT',
  'qbo_entity_id TEXT',
  'qbo_request_id TEXT',
  'posted_at TEXT',
  'payment_reference TEXT',
  'reimbursement_recipient_user_id TEXT',
  'payment_source TEXT',
  'payment_source_selected_by TEXT',
  'payment_source_selected_at TEXT',
  'payment_source_workflow_run_id TEXT',
  'payment_instruction_hash TEXT',
  'payment_instruction_queued_at TEXT',
];

const ACCOUNTING_BANK_TRANSACTION_COLUMNS = [
  'source_time TEXT',
  'source_operation TEXT',
  'source_transaction_code TEXT',
  'qbo_workflow_run_id TEXT REFERENCES workflow_runs(id)',
  'qbo_entity_type TEXT',
  'qbo_entity_id TEXT',
  'qbo_request_id TEXT',
  'qbo_category_key TEXT',
  'qbo_category_name TEXT',
  'qbo_recorded_at TEXT',
  'review_required INTEGER NOT NULL DEFAULT 0',
];

function ensureColumnsBetterSqlite(db, table, specs) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  for (const spec of specs) {
    const name = spec.split(/\s+/, 1)[0];
    if (!columns.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${spec}`);
  }
}

function proposalTableNeedsRebuild(columns) {
  const byName = new Map(columns.map(column => [column.name, column]));
  return Number(byName.get('outreach_send_id')?.notnull || 0) === 1
    || Number(byName.get('contact_id')?.notnull || 0) === 1
    || Number(byName.get('expires_at')?.notnull || 0) === 1;
}

function rebuildEmailReplyProposalsBetterSqlite(db) {
  const columns = db.prepare('PRAGMA table_info(email_reply_proposals)').all();
  if (!proposalTableNeedsRebuild(columns)) {
    ensureColumnsBetterSqlite(db, 'email_reply_proposals', EMAIL_REPLY_PROPOSAL_COLUMNS);
    return false;
  }
  const copy = EMAIL_REPLY_PROPOSAL_COPY_COLUMNS.join(', ');
  db.exec('DROP INDEX IF EXISTS idx_email_reply_proposals_status');
  db.exec('ALTER TABLE email_reply_proposals RENAME TO email_reply_proposals_legacy_020');
  db.exec(EMAIL_REPLY_PROPOSALS_CREATE);
  db.exec(`INSERT INTO email_reply_proposals (provider, ${copy})
    SELECT 'gmail', ${copy} FROM email_reply_proposals_legacy_020`);
  db.exec('DROP TABLE email_reply_proposals_legacy_020');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_email_reply_proposals_status
    ON email_reply_proposals(status, expires_at)`);
  return true;
}

async function ensureColumnsAsync(db, sql, table, specs) {
  const columns = new Set((await db.query(sql.__dangerous__rawValue(`PRAGMA table_info(${table})`))).map(row => row.name));
  for (const spec of specs) {
    const name = spec.split(/\s+/, 1)[0];
    if (!columns.has(name)) {
      await db.query(sql.__dangerous__rawValue(`ALTER TABLE ${table} ADD COLUMN ${spec}`));
    }
  }
}

async function rebuildEmailReplyProposalsAsync(db, sql) {
  const columns = await db.query(sql`PRAGMA table_info(email_reply_proposals)`);
  if (!proposalTableNeedsRebuild(columns)) {
    await ensureColumnsAsync(db, sql, 'email_reply_proposals', EMAIL_REPLY_PROPOSAL_COLUMNS);
    return false;
  }
  const copy = EMAIL_REPLY_PROPOSAL_COPY_COLUMNS.join(', ');
  await db.tx(async tx => {
    await tx.query(sql`DROP INDEX IF EXISTS idx_email_reply_proposals_status`);
    await tx.query(sql`ALTER TABLE email_reply_proposals RENAME TO email_reply_proposals_legacy_020`);
    await tx.query(sql.__dangerous__rawValue(EMAIL_REPLY_PROPOSALS_CREATE));
    await tx.query(sql.__dangerous__rawValue(`INSERT INTO email_reply_proposals (provider, ${copy})
      SELECT 'gmail', ${copy} FROM email_reply_proposals_legacy_020`));
    await tx.query(sql`DROP TABLE email_reply_proposals_legacy_020`);
    await tx.query(sql`CREATE INDEX IF NOT EXISTS idx_email_reply_proposals_status
      ON email_reply_proposals(status, expires_at)`);
  });
  return true;
}

function ensureSchemaBetterSqlite(db) {
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  rebuildEmailReplyProposalsBetterSqlite(db);
  ensureColumnsBetterSqlite(db, 'workflow_runs', WORKFLOW_RUN_COLUMNS);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_serialization
    ON workflow_runs(serialization_key) WHERE serialization_key IS NOT NULL`);
  ensureColumnsBetterSqlite(db, 'workflow_steps', WORKFLOW_STEP_COLUMNS);
  ensureColumnsBetterSqlite(db, 'workflow_effects', WORKFLOW_EFFECT_COLUMNS);
  ensureColumnsBetterSqlite(db, 'workflow_manual_reviews', WORKFLOW_MANUAL_REVIEW_COLUMNS);
  ensureColumnsBetterSqlite(db, 'workflow_outbox', WORKFLOW_OUTBOX_COLUMNS);
  ensureColumnsBetterSqlite(db, 'accounting_receipts', ACCOUNTING_RECEIPT_COLUMNS);
  ensureColumnsBetterSqlite(db, 'accounting_bank_transactions', ACCOUNTING_BANK_TRANSACTION_COLUMNS);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_accounting_bank_txn_identity
    ON accounting_bank_transactions(source_operation, source_transaction_code, source_time)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_receipts_qbo_entity
    ON accounting_receipts(qbo_entity_type, qbo_entity_id) WHERE qbo_entity_id IS NOT NULL`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_receipts_payment_reference
    ON accounting_receipts(payment_reference) WHERE payment_reference IS NOT NULL`);
  const columns = new Set(db.prepare('PRAGMA table_info(meta_messages)').all().map(row => row.name));
  if (columns.size > 0) {
    for (const spec of META_MESSAGE_COLUMNS) {
      const name = spec.split(/\s+/, 1)[0];
      if (!columns.has(name)) db.exec(`ALTER TABLE meta_messages ADD COLUMN ${spec}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_meta_msg_workflow_effect ON meta_messages(workflow_effect_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_meta_msg_processing ON meta_messages(processing_status, received_at)');
  }
  const ownerrezColumns = new Set(db.prepare('PRAGMA table_info(ownerrez_events)').all().map(row => row.name));
  for (const spec of OWNERREZ_EVENT_COLUMNS) {
    const name = spec.split(/\s+/, 1)[0];
    if (!ownerrezColumns.has(name)) db.exec(`ALTER TABLE ownerrez_events ADD COLUMN ${spec}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ownerrez_events_payload_hash
    ON ownerrez_events(payload_hash) WHERE payload_hash IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ownerrez_events_processing ON ownerrez_events(processing_status, received_at)');
  const outreachColumns = new Set(db.prepare('PRAGMA table_info(outreach_sends)').all().map(row => row.name));
  if (outreachColumns.size > 0) {
    for (const spec of OUTREACH_SEND_COLUMNS) {
      const name = spec.split(/\s+/, 1)[0];
      if (!outreachColumns.has(name)) db.exec(`ALTER TABLE outreach_sends ADD COLUMN ${spec}`);
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_outreach_sends_workflow_run ON outreach_sends(workflow_run_id)');
  }
  const emailThreadColumns = new Set(db.prepare('PRAGMA table_info(email_threads)').all().map(row => row.name));
  if (emailThreadColumns.size > 0) {
    ensureColumnsBetterSqlite(db, 'email_threads', EMAIL_THREAD_COLUMNS);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_threads_provider_message
      ON email_threads(provider, provider_message_id) WHERE provider_message_id IS NOT NULL`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_email_threads_processing ON email_threads(processing_status, received_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_email_threads_outreach_send ON email_threads(outreach_send_id, received_at)');
  }
}

async function ensureSchemaAsync(db, sql) {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.query(sql.__dangerous__rawValue(statement));
  }
  await rebuildEmailReplyProposalsAsync(db, sql);
  await ensureColumnsAsync(db, sql, 'workflow_runs', WORKFLOW_RUN_COLUMNS);
  await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_serialization
    ON workflow_runs(serialization_key) WHERE serialization_key IS NOT NULL`);
  await ensureColumnsAsync(db, sql, 'workflow_steps', WORKFLOW_STEP_COLUMNS);
  await ensureColumnsAsync(db, sql, 'workflow_effects', WORKFLOW_EFFECT_COLUMNS);
  await ensureColumnsAsync(db, sql, 'workflow_manual_reviews', WORKFLOW_MANUAL_REVIEW_COLUMNS);
  await ensureColumnsAsync(db, sql, 'workflow_outbox', WORKFLOW_OUTBOX_COLUMNS);
  await ensureColumnsAsync(db, sql, 'accounting_receipts', ACCOUNTING_RECEIPT_COLUMNS);
  await ensureColumnsAsync(db, sql, 'accounting_bank_transactions', ACCOUNTING_BANK_TRANSACTION_COLUMNS);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_accounting_bank_txn_identity
    ON accounting_bank_transactions(source_operation, source_transaction_code, source_time)`);
  await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_receipts_qbo_entity
    ON accounting_receipts(qbo_entity_type, qbo_entity_id) WHERE qbo_entity_id IS NOT NULL`);
  await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_receipts_payment_reference
    ON accounting_receipts(payment_reference) WHERE payment_reference IS NOT NULL`);
  const columns = new Set((await db.query(sql`PRAGMA table_info(meta_messages)`)).map(row => row.name));
  if (columns.size > 0) {
    for (const spec of META_MESSAGE_COLUMNS) {
      const name = spec.split(/\s+/, 1)[0];
      if (!columns.has(name)) {
        await db.query(sql.__dangerous__rawValue(`ALTER TABLE meta_messages ADD COLUMN ${spec}`));
      }
    }
    await db.query(sql`CREATE INDEX IF NOT EXISTS idx_meta_msg_workflow_effect ON meta_messages(workflow_effect_id)`);
    await db.query(sql`CREATE INDEX IF NOT EXISTS idx_meta_msg_processing
      ON meta_messages(processing_status, received_at)`);
  }
  const ownerrezColumns = new Set((await db.query(sql`PRAGMA table_info(ownerrez_events)`)).map(row => row.name));
  for (const spec of OWNERREZ_EVENT_COLUMNS) {
    const name = spec.split(/\s+/, 1)[0];
    if (!ownerrezColumns.has(name)) {
      await db.query(sql.__dangerous__rawValue(`ALTER TABLE ownerrez_events ADD COLUMN ${spec}`));
    }
  }
  await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ownerrez_events_payload_hash
    ON ownerrez_events(payload_hash) WHERE payload_hash IS NOT NULL`);
  await db.query(sql`CREATE INDEX IF NOT EXISTS idx_ownerrez_events_processing
    ON ownerrez_events(processing_status, received_at)`);
  const outreachColumns = new Set((await db.query(sql`PRAGMA table_info(outreach_sends)`)).map(row => row.name));
  if (outreachColumns.size > 0) {
    for (const spec of OUTREACH_SEND_COLUMNS) {
      const name = spec.split(/\s+/, 1)[0];
      if (!outreachColumns.has(name)) {
        await db.query(sql.__dangerous__rawValue(`ALTER TABLE outreach_sends ADD COLUMN ${spec}`));
      }
    }
    await db.query(sql`CREATE INDEX IF NOT EXISTS idx_outreach_sends_workflow_run
      ON outreach_sends(workflow_run_id)`);
  }
  const emailThreadColumns = new Set((await db.query(sql`PRAGMA table_info(email_threads)`)).map(row => row.name));
  if (emailThreadColumns.size > 0) {
    await ensureColumnsAsync(db, sql, 'email_threads', EMAIL_THREAD_COLUMNS);
    await db.query(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_threads_provider_message
      ON email_threads(provider, provider_message_id) WHERE provider_message_id IS NOT NULL`);
    await db.query(sql`CREATE INDEX IF NOT EXISTS idx_email_threads_processing
      ON email_threads(processing_status, received_at)`);
    await db.query(sql`CREATE INDEX IF NOT EXISTS idx_email_threads_outreach_send
      ON email_threads(outreach_send_id, received_at)`);
  }
}

module.exports = {
  META_MESSAGE_COLUMNS,
  EMAIL_THREAD_COLUMNS,
  EMAIL_REPLY_PROPOSAL_COLUMNS,
  OWNERREZ_EVENT_COLUMNS,
  OUTREACH_SEND_COLUMNS,
  SCHEMA_STATEMENTS,
  WORKFLOW_EFFECT_COLUMNS,
  WORKFLOW_MANUAL_REVIEW_COLUMNS,
  WORKFLOW_RUN_COLUMNS,
  WORKFLOW_OUTBOX_COLUMNS,
  WORKFLOW_STEP_COLUMNS,
  ensureSchemaAsync,
  ensureSchemaBetterSqlite,
  proposalTableNeedsRebuild,
  rebuildEmailReplyProposalsAsync,
  rebuildEmailReplyProposalsBetterSqlite,
};
