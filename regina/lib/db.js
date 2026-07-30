'use strict';
//
// db.js — shared SQLite connection helper for Regina scripts.
//
// Mirrors the @databases/sqlite usage in crm/scripts/ingest-airbnb-export.js.
// Each script opens its own handle and disposes when done.

const path = require('path');
const createDB = require('@databases/sqlite').default || require('@databases/sqlite');
const { sql } = require('@databases/sqlite');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_PATH = path.join(REPO_ROOT, 'crm', 'data', 'crm.db');

function openDb(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  const db = createDB(dbPath);
  return db;
}

module.exports = { openDb, sql, DEFAULT_DB_PATH };
