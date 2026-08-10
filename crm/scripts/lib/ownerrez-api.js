'use strict';

const https = require('https');

const DEFAULT_HOSTNAME = 'api.ownerrez.com';
const DEFAULT_USER_AGENT = 'OpenClaw LPDS/1.0';

/**
 * Build the read-only OwnerRez GET client shared by occupancy workflows.
 * Authentication stays in the caller so this module can be safely tested.
 */
function createApiGet({
  token,
  hostname = DEFAULT_HOSTNAME,
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = 15000,
} = {}) {
  if (!token) throw new Error('OwnerRez access token is required');

  return function apiGet(endpoint, params = {}) {
    return new Promise((resolve, reject) => {
      const query = new URLSearchParams(params).toString();
      const requestPath = `/v2/${endpoint}${query ? `?${query}` : ''}`;
      const request = https.request({
        hostname,
        path: requestPath,
        method: 'GET',
        headers: {
          'Authorization': `bearer ${token}`,
          'User-Agent': userAgent,
          'Accept': 'application/json',
        },
      }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch (error) {
            reject(new Error(`OwnerRez parse error on ${endpoint}: ${error.message}`));
            return;
          }

          if (response.statusCode >= 400 || (parsed.status_code && parsed.status_code >= 400)) {
            const status = parsed.status_code || response.statusCode;
            const detail = parsed.messages?.join(', ') || parsed.message || 'unknown error';
            reject(new Error(`OwnerRez API ${status} on ${endpoint}: ${detail}`));
            return;
          }

          resolve(parsed);
        });
      });

      request.on('error', reject);
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        reject(new Error(`OwnerRez timeout on ${endpoint}`));
      });
      request.end();
    });
  };
}

module.exports = {
  createApiGet,
  DEFAULT_HOSTNAME,
  DEFAULT_USER_AGENT,
};
