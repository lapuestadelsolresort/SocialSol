// crm/public/lp/sq-tracker.js — Squarespace session tracker.
// Lightweight version of tracker.js for the main lapuestadelsolresort.com site.
// Loaded cross-origin from webhook.lapuestadelsolresort.com/lp/sq-tracker.js.
// Creates page_sessions in the CRM via /api/track so ad traffic is visible in
// the funnel even when ads drive to the main site instead of custom LPs.

(function () {
  'use strict';
  var BASE = 'https://webhook.lapuestadelsolresort.com';
  var TRACK_URL = BASE + '/api/track';

  // Session ID: reuse tracker.js key for compatibility if both ever co-exist.
  var KEY = 'lpds_sid';
  var SID;
  try { SID = sessionStorage.getItem(KEY); } catch (e) { SID = null; }
  if (!SID) {
    SID = (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
          (Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { sessionStorage.setItem(KEY, SID); } catch (e) {}
  }
  window.LPDS_SID = SID;
  var WA_REF = SID.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 16);
  window.LPDS_WA_REF = WA_REF;

  function appendWaRef(a) {
    if (!a || !a.href || !WA_REF) return;
    try {
      var u = new URL(a.href, location.href);
      if (u.hostname !== 'wa.me' && u.hostname.indexOf('whatsapp.com') === -1) return;
      var text = u.searchParams.get('text') || '';
      text = text.replace(/\s*Reference:\s*LPDS-[A-Z0-9]{12,24}\s*/ig, '').trim();
      u.searchParams.set('text', text + (text ? '\n\n' : '') + 'Reference: LPDS-' + WA_REF);
      a.href = u.toString();
    } catch (e) {}
  }
  window.LPDS_APPEND_WA_REF = appendWaRef;

  var dnt = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.msDoNotTrack === '1';

  var start = performance.now();
  var activeMs = 0, lastActive = start;
  var maxScroll = 0;
  var queue = [];
  var flushTimer = null;

  function flushNow() {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    var body = JSON.stringify(batch);
    try {
      var blob = new Blob([body], { type: 'application/json' });
      if (navigator.sendBeacon && navigator.sendBeacon(TRACK_URL, blob)) return;
    } catch (e) {}
    try {
      fetch(TRACK_URL, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {}
  }
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () { flushTimer = null; flushNow(); }, 800);
  }
  function send(kind, target, meta) {
    queue.push({ sid: SID, kind: kind, target: target || null, meta: meta || null, ts: Date.now() });
    if (kind === 'abandon') flushNow();
    else scheduleFlush();
  }
  window.LPDS_TRACK = send;

  // --- pageview (always fires, even DNT — needed for session creation with UTMs) ---
  var params = new URLSearchParams(location.search);
  var storedUtms = {};
  try { storedUtms = JSON.parse(sessionStorage.getItem('lpds_utm') || '{}'); } catch (e) {}
  var currentUtms = {
    utm_source: params.get('utm_source') || storedUtms.utm_source || null,
    utm_medium: params.get('utm_medium') || storedUtms.utm_medium || null,
    utm_campaign: params.get('utm_campaign') || storedUtms.utm_campaign || null,
    utm_content: params.get('utm_content') || storedUtms.utm_content || null
  };
  if (params.get('utm_source')) {
    try { sessionStorage.setItem('lpds_utm', JSON.stringify(currentUtms)); } catch (e) {}
  }
  send('pageview', location.pathname, {
    page: 'main-site',
    ref: document.referrer || null,
    vw: innerWidth, vh: innerHeight,
    lang: (document.documentElement.lang || navigator.language || 'en').slice(0, 5),
    dev: matchMedia('(max-width:680px)').matches ? 'mobile' : (matchMedia('(max-width:1024px)').matches ? 'tablet' : 'desktop'),
    utm_source: currentUtms.utm_source,
    utm_medium: currentUtms.utm_medium,
    utm_campaign: currentUtms.utm_campaign,
    utm_content: currentUtms.utm_content,
    wa_ref: WA_REF
  });

  function wireWaRefs() {
    document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp.com"]').forEach(appendWaRef);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireWaRefs);
  else wireWaRefs();

  if (dnt) { window.LPDS_TRACK = function () {}; return; }

  // --- scroll depth ---
  addEventListener('scroll', function () {
    var h = document.documentElement.scrollHeight - innerHeight;
    var pct = h > 0 ? Math.min(100, Math.round((scrollY / h) * 100)) : 0;
    if (pct > maxScroll + 4) { maxScroll = pct; send('scroll', null, { pct: pct }); }
  }, { passive: true });

  // --- clicks: attribute to CTA-like elements ---
  document.addEventListener('click', function (e) {
    var el = e.target;
    var a = el.closest && el.closest('a[href], button, [role="button"]');
    if (!a) return;
    var text = (a.textContent || '').trim().slice(0, 60);
    var href = a.getAttribute('href') || '';
    var isWhatsApp = href.indexOf('wa.me') !== -1 || href.indexOf('whatsapp') !== -1;
    if (isWhatsApp) {
      appendWaRef(a);
      send('wa_click', 'btn:' + (text || 'WhatsApp'), { href: a.getAttribute('href') || '', page: 'main-site' });
      flushNow();
      return;
    }

    // Track other contact/book/reserve buttons as intent, not conversion.
    var lcText = text.toLowerCase();
    var isCta = /contact|book|reserve|inquir|get in touch|availability|whatsapp/i.test(lcText) ||
                isWhatsApp;

    if (isCta) {
      send('cta_click', 'btn:' + text, { href: href, page: 'main-site' });
    } else {
      send('click', 'btn:' + text);
    }
  });

  // --- dwell heartbeat (10s while visible) ---
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { activeMs += performance.now() - lastActive; }
    else { lastActive = performance.now(); }
  });
  setInterval(function () {
    if (!document.hidden) {
      activeMs += performance.now() - lastActive;
      lastActive = performance.now();
      send('heartbeat', null, { active_ms: Math.round(activeMs), max_scroll: maxScroll });
    }
  }, 10000);

  // --- abandon ---
  function unload() {
    activeMs += document.hidden ? 0 : (performance.now() - lastActive);
    send('abandon', null, { active_ms: Math.round(activeMs), max_scroll: maxScroll });
    flushNow();
  }
  addEventListener('pagehide', unload);
  addEventListener('beforeunload', unload);
})();
