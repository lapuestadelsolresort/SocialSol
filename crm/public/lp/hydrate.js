// crm/public/lp/hydrate.js — assign the variant + apply its copy to the page.
//
// Served by the resort CRM and loaded cross-origin in the Astro pages' <head>
// (right after tracker.js) so the /api/lp/config call fires as early as
// possible: the server-side variant assignment (lp_assignments +
// page_sessions.variant_id) happens on that GET, so even a sub-second visit is
// attributed to a variant. The DOM copy is applied once the document is ready.
//
// Progressive enhancement: if the config call fails or a field is absent, the
// static HTML is left exactly as-is.
//
// What a variant controls (config JSON):
//   hero.headline / hero.sub            → .hero-headline / .hero-sub
//   cta.text / cta.whatsapp_prefill     → every a.wa-cta label + href
//   social_proof.enabled / .lines       → pills inserted after the hero sub
//   urgency                             → a line inserted after the hero sub

(function () {
  'use strict';
  var BASE = (window.LPDS_BASE || 'https://webhook.lapuestadelsolresort.com').replace(/\/$/, '');
  var WA_NUMBER = '15553526612';

  var lang = document.documentElement.lang === 'es' ? 'es' : 'en';
  var page = window.LPDS_PAGE || '';
  var params = new URLSearchParams(location.search);
  var url = BASE + '/api/lp/config?sid=' + encodeURIComponent(window.LPDS_SID || '') +
            '&lang=' + lang + '&page_slug=' + encodeURIComponent(page);
  if (params.get('utm_source'))   url += '&utm_source='   + encodeURIComponent(params.get('utm_source'));
  if (params.get('utm_medium'))   url += '&utm_medium='   + encodeURIComponent(params.get('utm_medium'));
  if (params.get('utm_campaign')) url += '&utm_campaign=' + encodeURIComponent(params.get('utm_campaign'));
  if (params.get('utm_content'))  url += '&utm_content='  + encodeURIComponent(params.get('utm_content'));

  var configPromise = fetch(url)
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      if (payload && payload.config) {
        window.LPDS_VARIANT_ID = payload.variant_id;
        window.LPDS_VARIANT_SLUG = payload.variant_slug;
        window.LPDS_CONFIG = payload.config;
      }
      return payload;
    })
    .catch(function () { return null; });
  window.LPDS_CONFIG_PROMISE = configPromise;

  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function setText(sel, value) {
    if (value == null) return;
    var el = document.querySelector(sel);
    if (el) el.textContent = value;
  }

  // Replace an anchor's visible label text without clobbering its child SVG:
  // set the last non-empty text node, else append one.
  function setAnchorLabel(a, text) {
    if (!a || text == null) return;
    var node = null, i;
    for (i = a.childNodes.length - 1; i >= 0; i--) {
      var n = a.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) { node = n; break; }
    }
    if (node) node.nodeValue = ' ' + text;
    else a.appendChild(document.createTextNode(' ' + text));
  }

  function applyCta(cta) {
    cta = cta || {};
    document.querySelectorAll('a.wa-cta').forEach(function (a) {
      if (cta.text) setAnchorLabel(a, cta.text);
      if (cta.whatsapp_prefill) {
        a.setAttribute('href', 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(cta.whatsapp_prefill));
      }
      if (window.LPDS_APPEND_WA_REF) window.LPDS_APPEND_WA_REF(a);
    });
  }

  function insertAfterHeroSub(node) {
    var sub = document.querySelector('.hero-sub');
    if (sub && sub.parentNode) sub.parentNode.insertBefore(node, sub.nextSibling);
  }

  function applySocialProof(sp) {
    if (!sp || !sp.enabled || !Array.isArray(sp.lines) || !sp.lines.length) return;
    if (document.querySelector('.lpds-sp')) return;
    var wrap = document.createElement('div');
    wrap.className = 'lpds-sp';
    wrap.setAttribute('style', 'display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 18px;');
    sp.lines.forEach(function (line) {
      var pill = document.createElement('span');
      pill.setAttribute('style', 'background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);color:#fff;border-radius:999px;padding:5px 12px;font-size:12px;');
      pill.textContent = line;
      wrap.appendChild(pill);
    });
    insertAfterHeroSub(wrap);
  }

  function applyUrgency(text) {
    if (!text || document.querySelector('.lpds-urgency')) return;
    var el = document.createElement('p');
    el.className = 'lpds-urgency';
    el.setAttribute('style', 'color:#fff;font-size:13px;font-weight:500;margin:0 0 16px;');
    el.textContent = text;
    insertAfterHeroSub(el);
  }

  function apply(config) {
    if (!config) return;
    if (config.hero) {
      setText('.hero-headline', config.hero.headline);
      setText('.hero-sub', config.hero.sub);
    }
    applyUrgency(typeof config.urgency === 'string' ? config.urgency : (config.urgency && config.urgency.message));
    applySocialProof(config.social_proof);
    applyCta(config.cta);
    if (window.LPDS_OBSERVE_CTA) document.querySelectorAll('[data-cta]').forEach(window.LPDS_OBSERVE_CTA);
  }

  onReady(function () {
    // Tag the WhatsApp CTAs so the tracker records cta_view (reached_cta) even
    // if the config call is slow or fails.
    document.querySelectorAll('a.wa-cta').forEach(function (a) {
      if (!a.getAttribute('data-cta')) a.setAttribute('data-cta', a.getAttribute('data-event') || 'whatsapp_click');
      if (window.LPDS_APPEND_WA_REF) window.LPDS_APPEND_WA_REF(a);
    });
    if (window.LPDS_OBSERVE_CTA) document.querySelectorAll('[data-cta]').forEach(window.LPDS_OBSERVE_CTA);

    configPromise.then(function (payload) {
      if (payload && payload.config) apply(payload.config);
    });
  });
})();
