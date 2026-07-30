'use strict';
//
// chroma-connect.js — canonical Chroma connection helper.
//
// Why: launchd starts the CRM and Chroma in parallel after reboot. The CRM
// almost always wins the race, and a single one-shot heartbeat() at boot
// fails permanently — the client never retries, so the system stays in
// "not connected" until someone manually kickstarts the CRM.
//
// This helper provides:
//   - connectWithRetry: backoff-retry across ~39s for boot paths.
//   - connectOnce: single-shot for lazy-reconnect paths (e.g. an HTTP
//     handler that should self-heal on the next request without blocking
//     the caller for the full retry window).
//
// All Chroma callers in this repo (server.js initChroma, the voice-corpus
// indexer, and any future R3+ consumers) MUST go through one of these.

const { ChromaClient } = require('chromadb');

const RETRY_DELAYS_MS = [1000, 2000, 4000, 4000, 4000, 8000, 8000, 8000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryHeartbeat(url) {
  const client = new ChromaClient({ path: url });
  await client.heartbeat();
  return client;
}

async function connectWithRetry({ url, label = 'chroma' }) {
  let lastErr;
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      const client = await tryHeartbeat(url);
      if (i > 0) console.log(`[${label}] connected on attempt ${i + 1}`);
      return client;
    } catch (e) {
      lastErr = e;
      if (i === RETRY_DELAYS_MS.length) break;
      const delay = RETRY_DELAYS_MS[i];
      console.warn(`[${label}] heartbeat attempt ${i + 1} failed (${e.message}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function connectOnce({ url }) {
  return tryHeartbeat(url);
}

module.exports = { connectWithRetry, connectOnce, RETRY_DELAYS_MS };
