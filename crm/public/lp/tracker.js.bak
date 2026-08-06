// crm/public/lp/tracker.js — landing-page behavior tracker. Vanilla JS, no deps.
//
// Served by the resort CRM (https://webhook.lapuestadelsolresort.com/lp/
// tracker.js) and loaded cross-origin by the Astro landing pages. Boots
// immediately, mints a per-tab session id, and posts compact events to
// <LPDS_BASE>/api/track via sendBeacon. Exposes window.LPDS_SID and
// window.LPDS_TRACK(kind, target, meta).
//
// Conversion = the WhatsApp button. A capture-phase click on a.wa-cta fires a
// `wa_click` event and flushes synchronously so it lands before the wa.me tab
// opens (server marks page_sessions.converted = 1).
//
// PRIVACY: only metadata is ever sent — element ids, scroll %, timings. Honors
// Do Not Track: when DNT is on, LPDS_SID is still available but no behavioral
// events are sent.

(function () {
  'use strict';
  var BASE = (window.LPDS_BASE || 'https://webhook.lapuestadelsolresort.com').replace(/\/$/, '');
  var TRACK_URL = BASE + '/api/track';
  var PAGE = window.LPDS_PAGE || null;

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

  // Do Not Track: still fire the initial pageview for first-party UTM attribution
  // (Facebook's in-app browser sets DNT=1, which was silently dropping all sessions).
  // Behavioral events (scroll, click, heartbeat, cta_view) are skipped for DNT users.
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
    if (kind === 'wa_click' || kind === 'abandon') flushNow();
    else scheduleFlush();
  }
  window.LPDS_TRACK = send;

  // --- boot pageview with UTM + viewport + page meta (always fires, even for DNT) ---
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
    page: PAGE,
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
    document.querySelectorAll('a.wa-cta, a[href*="wa.me"], a[href*="whatsapp.com"]').forEach(appendWaRef);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireWaRefs);
  else wireWaRefs();

  // --- DNT: skip all behavioral tracking after pageview ---
  if (dnt) {
    window.LPDS_TRACK = function () {};
    window.LPDS_OBSERVE_CTA = function () {};
    return;
  }

  // --- scroll depth (>4% buckets) ---
  addEventListener('scroll', function () {
    var h = document.documentElement.scrollHeight - innerHeight;
    var pct = h > 0 ? Math.min(100, Math.round((scrollY / h) * 100)) : 0;
    if (pct > maxScroll + 4) { maxScroll = pct; send('scroll', null, { pct: pct }); }
  }, { passive: true });

  // --- WhatsApp conversion: capture-phase so it fires before the anchor's
  //     navigation, then flush synchronously (sendBeacon survives the new tab). ---
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a.wa-cta');
    if (!a) return;
    appendWaRef(a);
    var label = a.getAttribute('data-event') || 'whatsapp_click';
    send('wa_click', 'cta:' + label, { page: PAGE, href: a.getAttribute('href') || null });
    flushNow();
  }, true);

  // --- clicks: attribute to the ACTUAL control (telemetry, not conversion) ---
  function clickTarget(el) {
    if (!el || !el.closest) return null;
    var btn = el.closest('button, a[href], [role="button"], input[type="submit"], input[type="button"]');
    if (btn) return 'btn:' + (btn.id || btn.getAttribute('data-cta') || (btn.textContent || '').trim().slice(0, 40));
    return null;
  }
  var lastClick = { ts: 0, x: 0, y: 0 };
  document.addEventListener('click', function (e) {
    var target = clickTarget(e.target);
    var now = Date.now();
    var isRage = now - lastClick.ts < 800 && Math.hypot(e.clientX - lastClick.x, e.clientY - lastClick.y) < 30;
    if (isRage) send('rageclick', target || e.target.tagName.toLowerCase());
    else if (target) send('click', target);
    else send('deadclick', e.target.tagName.toLowerCase());
    lastClick = { ts: now, x: e.clientX, y: e.clientY };
  });

  // --- CTA viewport visibility (fires once per element after ≥600ms visible) ---
  if ('IntersectionObserver' in window) {
    var seen = new WeakSet();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting && !seen.has(en.target)) {
          seen.add(en.target);
          var el = en.target;
          setTimeout(function () {
            if (el.isConnected) send('cta_view', 'cta:' + (el.getAttribute('data-cta') || el.id || ''));
          }, 600);
        }
      });
    }, { threshold: 0.6 });
    var observe = function (el) { try { io.observe(el); } catch (e) {} };
    window.LPDS_OBSERVE_CTA = observe;
    var wire = function () { document.querySelectorAll('[data-cta]').forEach(observe); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  } else {
    window.LPDS_OBSERVE_CTA = function () {};
  }

  // --- dwell (heartbeat every 10s while visible) ---
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { activeMs += performance.now() - lastActive; send('hidden', null, { active_ms: Math.round(activeMs) }); }
    else { lastActive = performance.now(); send('visible'); }
  });
  setInterval(function () {
    if (!document.hidden) {
      activeMs += performance.now() - lastActive;
      lastActive = performance.now();
      send('heartbeat', null, { active_ms: Math.round(activeMs), max_scroll: maxScroll });
    }
  }, 10000);

  // --- abandon on unload ---
  function unload() {
    activeMs += document.hidden ? 0 : (performance.now() - lastActive);
    send('abandon', null, { active_ms: Math.round(activeMs), max_scroll: maxScroll });
    flushNow();
  }
  addEventListener('pagehide', unload);
  addEventListener('beforeunload', unload);
})();
