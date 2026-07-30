'use strict';

const fs = require('fs');
const path = require('path');

const RESEARCH_ROOT = path.resolve(__dirname, '..', '..');
const PROSPECTOR_ROOT = path.resolve(RESEARCH_ROOT, '..');
const REPO_ROOT = path.resolve(PROSPECTOR_ROOT, '..');
const CRM_DB = path.resolve(
  process.env.DB_PATH || path.join(REPO_ROOT, 'crm', 'data', 'crm.db'),
);

const CONFIG_PATH = path.join(PROSPECTOR_ROOT, 'config.json');
const QUERIES_PATH = path.join(RESEARCH_ROOT, 'queries.json');

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  if (!cfg.research) {
    throw new Error(`prospector/config.json is missing the 'research' block`);
  }
  return cfg;
}

function loadQueries() {
  const raw = fs.readFileSync(QUERIES_PATH, 'utf8');
  return JSON.parse(raw);
}

function runDir(date) {
  return path.join(RESEARCH_ROOT, 'runs', date);
}

function cacheDir() {
  return path.join(RESEARCH_ROOT, 'cache', 'pages');
}

function todayISODate() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

module.exports = {
  RESEARCH_ROOT,
  PROSPECTOR_ROOT,
  REPO_ROOT,
  CRM_DB,
  CONFIG_PATH,
  QUERIES_PATH,
  loadConfig,
  loadQueries,
  runDir,
  cacheDir,
  todayISODate,
};
