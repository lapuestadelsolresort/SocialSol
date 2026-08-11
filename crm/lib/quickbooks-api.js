'use strict';

const { getValidAccessToken, readStore } = require('./quickbooks-store');

async function context() {
  const [{ accessToken, realmId }, store] = await Promise.all([getValidAccessToken(), readStore()]);
  const baseUrl = store?.env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
  return { accessToken, realmId, baseUrl };
}

async function qboGet(pathname, params = {}, fetchImpl = fetch) {
  const { accessToken, realmId, baseUrl } = await context();
  const url = new URL(`${baseUrl}/v3/company/${realmId}/${pathname}`);
  url.searchParams.set('minorversion', '75');
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`QuickBooks read failed (${response.status})`);
    error.code = 'qbo_read_failed';
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return { payload, realmId };
}

async function readBankAccounts() {
  const query = "SELECT * FROM Account WHERE AccountType = 'Bank' MAXRESULTS 1000";
  const { payload, realmId } = await qboGet('query', { query });
  const accounts = payload.QueryResponse?.Account || [];
  return {
    realmId,
    observedAt: payload.time || new Date().toISOString(),
    accounts: accounts.map(account => ({
      id: account.Id,
      name: account.FullyQualifiedName || account.Name,
      active: account.Active !== false,
      currency: account.CurrencyRef?.value || null,
      currentBalance: Number(account.CurrentBalance || 0),
      currentBalanceWithSubAccounts: Number(account.CurrentBalanceWithSubAccounts ?? account.CurrentBalance ?? 0),
      lastUpdatedAt: account.MetaData?.LastUpdatedTime || null,
    })),
  };
}

const REPORTS = new Set(['BalanceSheet', 'ProfitAndLoss', 'CashFlow']);

async function readReport({ report, startDate = null, endDate = null, accountingMethod = 'Accrual' }) {
  if (!REPORTS.has(report)) throw new Error('unsupported QuickBooks report');
  const params = { accounting_method: accountingMethod };
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  const { payload, realmId } = await qboGet(`reports/${report}`, params);
  return { realmId, observedAt: payload.Header?.Time || new Date().toISOString(), report: payload };
}

module.exports = { REPORTS, qboGet, readBankAccounts, readReport };
