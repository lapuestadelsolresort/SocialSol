"""
QuickBooks Online Push Module

Writes classified Kapital transactions to QBO as Purchase (expense)
or Deposit (income) records. Handles token refresh, vendor lookup,
and MXN→USD conversion.
"""

import base64
import hashlib
import json
import os
import urllib.request
import urllib.error
import urllib.parse
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class QBOClient:
    """QuickBooks Online API client."""

    def __init__(self, secrets_path: str = None):
        if secrets_path is None:
            secrets_dir = Path(os.environ.get(
                'SOCIALSOL_SECRETS_DIR', Path(__file__).parent.parent / 'secrets'
            ))
            secrets_path = str(secrets_dir / 'quickbooks.json')
        self.secrets_path = secrets_path
        self._load_secrets()

    def _load_secrets(self):
        with open(self.secrets_path) as f:
            data = json.load(f)
        tokens = data.get('tokens', {})
        self.realm_id = data.get('realmId') or data.get('realm_id')
        credentials = data.get('production') or data.get('development') or {}
        if not credentials.get('client_id'):
            dev_path = Path(self.secrets_path).with_name('quickbooks-dev.json')
            if dev_path.is_file():
                credentials = json.loads(dev_path.read_text())
        self.client_id = credentials.get('client_id')
        self.client_secret = credentials.get('client_secret')
        self.access_token = data.get('access_token') or tokens.get('access_token')
        self.refresh_token = data.get('refresh_token') or tokens.get('refresh_token')
        missing = [name for name, value in {
            'realm id': self.realm_id,
            'client id': self.client_id,
            'client secret': self.client_secret,
            'access token': self.access_token,
            'refresh token': self.refresh_token,
        }.items() if not value]
        if missing:
            raise ValueError(f"QuickBooks credentials missing: {', '.join(missing)}")
        base = str(data.get('base_url') or '').rstrip('/')
        if '/v3/company/' in base:
            self.base_url = base
        else:
            api_host = (
                'https://sandbox-quickbooks.api.intuit.com'
                if data.get('env') == 'sandbox'
                else 'https://quickbooks.api.intuit.com'
            )
            self.base_url = f"{api_host}/v3/company/{self.realm_id}"

    def _save_tokens(self, access_token: str, refresh_token: str):
        with open(self.secrets_path) as f:
            data = json.load(f)
        now = datetime.now(timezone.utc).isoformat()
        if data.get('tokens') is not None or data.get('production') is not None or data.get('realm_id') is not None:
            data.setdefault('tokens', {})['access_token'] = access_token
            data['tokens']['refresh_token'] = refresh_token
            data['tokens']['obtained_at'] = now
        else:
            data['access_token'] = access_token
            data['refresh_token'] = refresh_token
            data['updated_at'] = now
        tmp = self.secrets_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.secrets_path)
        os.chmod(self.secrets_path, 0o600)
        self.access_token = access_token
        self.refresh_token = refresh_token

    def refresh_auth(self) -> bool:
        """Refresh the OAuth2 token."""
        try:
            body = urllib.parse.urlencode({
                'grant_type': 'refresh_token',
                'refresh_token': self.refresh_token,
            }).encode()
            basic = base64.b64encode(
                f"{self.client_id}:{self.client_secret}".encode()
            ).decode()
            req = urllib.request.Request(
                "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
                data=body,
                headers={
                    "Authorization": f"Basic {basic}",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Accept": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode())
            new_access = data.get('access_token')
            new_refresh = data.get('refresh_token')
            if new_access:
                self._save_tokens(new_access, new_refresh or self.refresh_token)
                return True
        except Exception as e:
            print(f"Token refresh failed: {e}")
        return False

    def _api_call(
        self,
        method: str,
        endpoint: str,
        body: dict = None,
        retry: bool = True,
        request_id: str = None,
    ) -> dict:
        """Make an authenticated API call to QBO."""
        separator = '&' if '?' in endpoint else '?'
        url = f"{self.base_url}/{endpoint}{separator}minorversion=75"
        if request_id:
            url += f"&requestid={urllib.parse.quote(str(request_id)[:50])}"
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Accept": "application/json",
        }

        data_bytes = None
        if body:
            headers["Content-Type"] = "application/json"
            data_bytes = json.dumps(body).encode()

        req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:
                if self.refresh_auth():
                    return self._api_call(method, endpoint, body, retry=False, request_id=request_id)
            error_body = e.read().decode() if e.fp else str(e)
            raise RuntimeError(f"QBO API {e.code}: {error_body}")

    def query(self, sql: str) -> dict:
        """Run a QBO query."""
        import urllib.parse
        encoded = urllib.parse.quote(sql)
        return self._api_call("GET", f"query?query={encoded}")

    def create_purchase(self, txn: Dict, request_id: str = None) -> Dict:
        """
        Create a Purchase (Check/CashPurchase) in QBO for an expense transaction.

        Args:
            txn: classified transaction dict with keys:
                - date, amount_usd, category (QBO account key), vendor_key,
                - description, note, reference
        """
        account_id = self._resolve_account_id(txn.get('category'))
        vendor_id = self._resolve_vendor_id(txn.get('vendor_key'))
        amount_usd = txn.get('amount_usd', 0)
        txn_date = txn.get('date')

        if not account_id:
            raise ValueError(f"No QBO account for category: {txn.get('category')}")
        if not amount_usd or amount_usd <= 0:
            raise ValueError(f"Invalid USD amount: {amount_usd}")

        # Build memo from description + note
        memo_parts = []
        if txn.get('note'):
            memo_parts.append(txn['note'])
        desc = txn.get('description', '')
        if desc and len(desc) < 200:
            memo_parts.append(f"Kapital: {desc[:150]}")
        if txn.get('reference'):
            memo_parts.append(f"Ref: {txn['reference'][:80]}")
        if txn.get('fx_rate'):
            memo_parts.append(f"FX: {txn['fx_rate']} MXN/USD, orig ${txn.get('amount', 0):,.2f} MXN")

        memo = ' | '.join(memo_parts)[:4000]  # QBO memo limit

        purchase = {
            "PaymentType": "Cash",
            "AccountRef": {"value": "1150040001"},  # Kapital bank account
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "CurrencyRef": {"value": "USD"},
            "TotalAmt": round(amount_usd, 2),
            "PrivateNote": memo,
            "Line": [{
                "Amount": round(amount_usd, 2),
                "DetailType": "AccountBasedExpenseLineDetail",
                "AccountBasedExpenseLineDetail": {
                    "AccountRef": {"value": str(account_id)},
                },
                "Description": memo[:4000],
            }],
        }

        # Add vendor if known
        if vendor_id:
            purchase["EntityRef"] = {"value": str(vendor_id), "type": "Vendor"}

        # SPEI fees are now pushed as separate records (not bundled)
        # to avoid 'split' display in QBO

        result = self._api_call("POST", "purchase", purchase, request_id=request_id)
        return result.get('Purchase', result)

    def create_spei_fee(self, fee: Dict, parent_txn: Dict, request_id: str = None) -> Dict:
        """
        Create a separate Purchase for a SPEI commission or IVA line.
        """
        bank_fee_id = self._resolve_account_id('bank_fee')
        if not bank_fee_id:
            raise ValueError("No QBO account for bank_fee")

        fee_usd = fee.get('amount_usd', 0) or 0
        if not fee_usd or fee_usd <= 0:
            return {}  # Skip zero fees

        txn_date = parent_txn.get('date')
        fee_type = 'SPEI IVA' if fee.get('is_spei_iva') else 'SPEI Commission'
        vendor_name = parent_txn.get('vendor_name', 'N/A')

        memo = f"{fee_type} on transfer to {vendor_name}"
        if parent_txn.get('fx_rate'):
            memo += f" | FX: {parent_txn['fx_rate']} MXN/USD, orig ${fee.get('amount', 0):,.2f} MXN"

        purchase = {
            "PaymentType": "Cash",
            "AccountRef": {"value": "1150040001"},
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "CurrencyRef": {"value": "USD"},
            "TotalAmt": round(fee_usd, 2),
            "EntityRef": {"value": "16", "type": "Vendor"},  # Kapital Mexico
            "PrivateNote": memo,
            "Line": [{
                "Amount": round(fee_usd, 2),
                "DetailType": "AccountBasedExpenseLineDetail",
                "AccountBasedExpenseLineDetail": {
                    "AccountRef": {"value": str(bank_fee_id)},
                },
                "Description": memo,
            }],
        }

        result = self._api_call("POST", "purchase", purchase, request_id=request_id)
        return result.get('Purchase', result)

    def create_deposit(self, txn: Dict, request_id: str = None) -> Dict:
        """
        Create a Deposit in QBO for an income transaction.
        """
        amount_usd = txn.get('amount_usd', 0)
        txn_date = txn.get('date')
        category = txn.get('category', '')

        if not amount_usd or amount_usd <= 0:
            raise ValueError(f"Invalid USD amount: {amount_usd}")

        # Resolve income account
        income_account_id = self._resolve_income_account_id(category)
        if not income_account_id:
            raise ValueError(f"No QBO income account for category: {category}")

        memo_parts = []
        if txn.get('note'):
            memo_parts.append(txn['note'])
        desc = txn.get('description', '')
        if desc and len(desc) < 200:
            memo_parts.append(f"Kapital: {desc[:150]}")
        if txn.get('fx_rate'):
            memo_parts.append(f"FX: {txn['fx_rate']} MXN/USD, orig ${txn.get('amount', 0):,.2f} MXN")
        memo = ' | '.join(memo_parts)[:4000]

        deposit = {
            "DepositToAccountRef": {"value": "1150040001"},  # Kapital bank account
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "CurrencyRef": {"value": "USD"},
            "TotalAmt": round(amount_usd, 2),
            "PrivateNote": memo,
            "Line": [{
                "Amount": round(amount_usd, 2),
                "DetailType": "DepositLineDetail",
                "DepositLineDetail": {
                    "AccountRef": {"value": str(income_account_id)},
                },
                "Description": memo[:4000],
            }],
        }

        result = self._api_call("POST", "deposit", deposit, request_id=request_id)
        return result.get('Deposit', result)

    def create_transfer(self, txn: Dict, request_id: str = None) -> Dict:
        """
        Create a Transfer in QBO for owner funding or internal transfers.
        """
        amount_usd = txn.get('amount_usd', 0)
        txn_date = txn.get('date')

        if not amount_usd or amount_usd <= 0:
            raise ValueError(f"Invalid USD amount: {amount_usd}")

        memo_parts = []
        if txn.get('note'):
            memo_parts.append(txn['note'])
        if txn.get('fx_rate'):
            memo_parts.append(f"FX: {txn['fx_rate']} MXN/USD, orig ${txn.get('amount', 0):,.2f} MXN")
        memo = ' | '.join(memo_parts)[:4000]

        transfer = {
            "FromAccountRef": {"value": "9"},  # BofA checking
            "ToAccountRef": {"value": "1150040001"},  # Kapital
            "TxnDate": txn_date.isoformat() if isinstance(txn_date, date) else str(txn_date),
            "Amount": round(amount_usd, 2),
            "PrivateNote": memo,
        }

        result = self._api_call("POST", "transfer", transfer, request_id=request_id)
        return result.get('Transfer', result)

    def create_journal_entry(self, journal_entry: Dict, request_id: str = None) -> Dict:
        """Create a JournalEntry with a stable provider request id."""
        result = self._api_call(
            "POST", "journalentry", journal_entry, request_id=request_id
        )
        return result.get('JournalEntry', result)

    def create_purchase_payload(self, purchase: Dict, request_id: str = None) -> Dict:
        """Create a fully specified Purchase with a stable provider request id."""
        result = self._api_call("POST", "purchase", purchase, request_id=request_id)
        return result.get('Purchase', result)

    def read_entity(self, entity_type: str, entity_id: str) -> Dict:
        """Read a just-written entity back from QBO."""
        result = self._api_call("GET", f"{entity_type}/{entity_id}")
        key = {
            'purchase': 'Purchase',
            'deposit': 'Deposit',
            'transfer': 'Transfer',
            'journalentry': 'JournalEntry',
            'account': 'Account',
        }[entity_type]
        return result.get(key, result)

    def read_account(self, account_id: str) -> Dict:
        """Read a QBO account by id for a live posting preflight."""
        return self.read_entity('account', str(account_id))

    def _resolve_account_id(self, category_key: str) -> Optional[str]:
        """Look up QBO account ID from config category key."""
        if not category_key:
            return None
        config_path = str(Path(__file__).parent / 'config.json')
        with open(config_path) as f:
            config = json.load(f)
        accounts = config.get('qbo_accounts', {}).get('expenses', {})
        account = accounts.get(category_key, {})
        return account.get('id')

    def _resolve_income_account_id(self, category_key: str) -> Optional[str]:
        """Look up QBO income account ID from config."""
        if not category_key:
            return None
        config_path = str(Path(__file__).parent / 'config.json')
        with open(config_path) as f:
            config = json.load(f)
        income = config.get('qbo_accounts', {}).get('income', {})
        account = income.get(category_key, {})
        return account.get('id')

    def _resolve_vendor_id(self, vendor_key: str) -> Optional[str]:
        """Look up QBO vendor ID from config vendor key."""
        if not vendor_key:
            return None
        config_path = str(Path(__file__).parent / 'config.json')
        with open(config_path) as f:
            config = json.load(f)
        vendors = config.get('vendors', {})
        vendor = vendors.get(vendor_key, {})
        return vendor.get('id')


def qbo_request_id(txn: Dict, record_type: str, suffix: str = '') -> str:
    """Stable, non-PII QBO requestid for a Kapital-derived write."""
    raw = '|'.join([
        'socialsol', record_type, str(txn.get('date') or ''),
        str(txn.get('reference') or txn.get('clave') or txn.get('description') or ''),
        str(txn.get('amount') or ''), str(txn.get('category') or ''), suffix,
    ])
    digest = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:36]
    return f"ss-{record_type[:3]}-{digest}"[:50]


def push_classified_to_qbo(
    results: Dict[str, List[Dict]],
    push_auto: bool = True,
    push_guess: bool = False,
    dry_run: bool = True,
) -> Dict:
    """
    Push classified transactions to QBO.

    Args:
        results: output from classifier.classify_all()
        push_auto: push auto-classified expenses
        push_guess: push guess-classified expenses (only after Mayela confirms)
        dry_run: if True, don't actually push

    Returns:
        Summary dict with counts and any errors
    """
    client = QBOClient()
    summary = {
        'expenses_pushed': 0,
        'income_pushed': 0,
        'transfers_pushed': 0,
        'skipped': 0,
        'errors': [],
        'warnings': [],
        'details': [],
    }

    # Categories that are internal transfers (not income, not expense)
    TRANSFER_CATS = ('owner_transfer', 'fx_conversion')
    # Categories that are income deposits
    INCOME_CATS = ('income_airbnb', 'income_direct', 'income_vrbo', 'bank_interest')
    # Skip these (they net to zero or are negligible)
    SKIP_CATS = ('income_other',)

    # Run dedup check before pushing
    from dedup import check_for_duplicates
    all_txns = []
    if push_auto:
        all_txns.extend(results.get('auto', []))
    if push_guess:
        all_txns.extend(results.get('guess', []))

    try:
        new_txns, dupes = check_for_duplicates(all_txns, client.access_token, client.base_url)
        summary['dedup_skipped'] = len(dupes)
        if dupes:
            for d in dupes:
                summary['warnings'].append(
                    f"DEDUP SKIP: {d.get('date')} ${d.get('amount_usd', 0):.2f} — {d.get('_dedup_reason', 'duplicate')}"
                )
        # Rebuild bucket lists with only new transactions
        new_set = set(id(t) for t in new_txns)
        buckets_to_push = []
        if push_auto:
            buckets_to_push.append(('auto', [t for t in results.get('auto', []) if id(t) in new_set]))
        if push_guess:
            buckets_to_push.append(('guess', [t for t in results.get('guess', []) if id(t) in new_set]))
    except Exception as e:
        # A failed duplicate check makes a live retry unsafe. Fail closed
        # before creating any QBO entity.
        raise RuntimeError(f"QBO dedup preflight failed; no writes attempted: {e}") from e

    for bucket_name, txns in buckets_to_push:
        for txn in txns:
            category = txn.get('category', '')

            # Skip if no USD amount
            if not txn.get('amount_usd'):
                summary['skipped'] += 1
                if txn.get('amount', 0) > 0.05:  # Only log meaningful skips
                    summary['errors'].append(f"No USD amount for {txn.get('date')} {txn.get('description', '')[:40]}")
                continue

            # Skip bank fee credits (fiscal stamp discount — $0.01, nets to zero)
            if category == 'bank_fee' and txn.get('category_name', '').endswith('(credit)'):
                summary['skipped'] += 1
                continue

            # Skip unknown income
            if category in SKIP_CATS:
                summary['skipped'] += 1
                continue

            # Determine record type
            if category in TRANSFER_CATS:
                record_type = 'transfer'
            elif category in INCOME_CATS:
                record_type = 'deposit'
            else:
                record_type = 'expense'

            if dry_run:
                key = f'{record_type}s_pushed' if record_type != 'expense' else 'expenses_pushed'
                summary[key] = summary.get(key, 0) + 1
                summary['details'].append({
                    'date': str(txn.get('date')),
                    'amount_usd': txn.get('amount_usd'),
                    'category': txn.get('category_name'),
                    'vendor': txn.get('vendor_name'),
                    'record_type': record_type,
                    'bucket': bucket_name,
                    'status': 'DRY_RUN',
                })
                continue

            try:
                request_id = qbo_request_id(txn, record_type)
                if record_type == 'transfer':
                    result = client.create_transfer(txn, request_id=request_id)
                    qbo_id = result.get('Id', 'unknown')
                    summary['transfers_pushed'] += 1
                elif record_type == 'deposit':
                    result = client.create_deposit(txn, request_id=request_id)
                    qbo_id = result.get('Id', 'unknown')
                    summary['income_pushed'] += 1
                else:
                    result = client.create_purchase(txn, request_id=request_id)
                    qbo_id = result.get('Id', 'unknown')
                    summary['expenses_pushed'] += 1

                    # Push SPEI fees as separate records
                    for fee_index, fee in enumerate(txn.get('spei_fees', [])):
                        fee_usd = fee.get('amount_usd', 0) or 0
                        if fee_usd > 0:
                            try:
                                fee_request_id = qbo_request_id(txn, 'purchase', f"spei-{fee_index}")
                                fee_result = client.create_spei_fee(
                                    fee, txn, request_id=fee_request_id
                                )
                                fee_id = fee_result.get('Id')
                                if not fee_id:
                                    raise RuntimeError('QBO SPEI fee create returned no Id')
                                fee_readback = client.read_entity('purchase', fee_id)
                                if str(fee_readback.get('Id')) != str(fee_id):
                                    raise RuntimeError(f'QBO SPEI fee readback mismatch for {fee_id}')
                                summary['expenses_pushed'] += 1
                            except Exception as fe:
                                summary['errors'].append(f"SPEI fee for {txn.get('date')}: {fe}")

                if not qbo_id or qbo_id == 'unknown':
                    raise RuntimeError('QBO create returned no entity Id')
                entity_type = 'purchase' if record_type == 'expense' else record_type
                readback = client.read_entity(entity_type, qbo_id)
                if str(readback.get('Id')) != str(qbo_id):
                    raise RuntimeError(f"QBO {record_type} readback mismatch for {qbo_id}")

                summary['details'].append({
                    'date': str(txn.get('date')),
                    'amount_usd': txn.get('amount_usd'),
                    'category': txn.get('category_name'),
                    'vendor': txn.get('vendor_name'),
                    'qbo_id': qbo_id,
                    'request_id': request_id,
                    'verified_by_readback': True,
                    'record_type': record_type,
                    'bucket': bucket_name,
                    'status': 'PUSHED',
                })
            except Exception as e:
                summary['errors'].append(f"{txn.get('date')} ${txn.get('amount_usd')} ({record_type}): {e}")

    return summary


if __name__ == '__main__':
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from kapital_parser import parse_kapital_csv
    from classifier import KapitalClassifier
    from fx_rates import get_usd_rate, convert_mxn_to_usd

    if len(sys.argv) < 2:
        print("Usage: python qbo_push.py <csv_file> [--live] [--json]")
        sys.exit(1)

    csv_path = sys.argv[1]
    is_live = '--live' in sys.argv
    output_json = '--json' in sys.argv

    meta, txns = parse_kapital_csv(csv_path)
    classifier = KapitalClassifier()
    results = classifier.classify_all(txns)

    # Add FX
    for bucket in results.values():
        for txn in bucket:
            if txn.get('date'):
                try:
                    rate = get_usd_rate(txn['date'])
                    txn['fx_rate'] = rate
                    txn['amount_usd'] = convert_mxn_to_usd(txn['amount'], txn['date'])
                    if txn.get('spei_fees'):
                        for fee in txn['spei_fees']:
                            fee['amount_usd'] = convert_mxn_to_usd(fee['amount'], txn['date'])
                except Exception:
                    txn['amount_usd'] = None

    dry_run = not is_live
    summary = push_classified_to_qbo(results, push_auto=True, push_guess=False, dry_run=dry_run)

    if output_json:
        print(json.dumps(summary, default=str))
    else:
        mode = "LIVE" if is_live else "DRY RUN"
        print(f"\n{'='*50}")
        print(f"QBO Push ({mode})")
        print(f"  Expenses: {summary['expenses_pushed']}")
        print(f"  Income/Deposits: {summary['income_pushed']}")
        print(f"  Transfers: {summary['transfers_pushed']}")
        print(f"  Skipped: {summary['skipped']}")
        if summary['errors']:
            print(f"  Errors ({len(summary['errors'])}):")
            for err in summary['errors']:
                print(f"    - {err}")

        if summary['details']:
            print(f"\n  Transactions:")
            for d in summary['details']:
                vendor = d.get('vendor') or 'N/A'
                rtype = d.get('record_type', 'expense')[0].upper()
                print(f"    {d['date']} | {rtype} | ${d['amount_usd']:>8.2f} USD | {d['category']:<25} | {vendor:<20} | {d['status']}")

    if is_live and summary['errors']:
        sys.exit(1)
