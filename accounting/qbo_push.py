"""
QuickBooks Online Push Module

Writes classified Kapital transactions to QBO as Purchase (expense)
or Deposit (income) records. Handles token refresh, vendor lookup,
and MXN→USD conversion.
"""

import json
import urllib.request
import urllib.error
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class QBOClient:
    """QuickBooks Online API client."""

    def __init__(self, secrets_path: str = None):
        if secrets_path is None:
            secrets_path = str(Path(__file__).parent.parent / 'secrets' / 'quickbooks.json')
        self.secrets_path = secrets_path
        self._load_secrets()
        self.base_url = f"https://quickbooks.api.intuit.com/v3/company/{self.realm_id}"

    def _load_secrets(self):
        with open(self.secrets_path) as f:
            data = json.load(f)
        self.realm_id = data['realm_id']
        self.client_id = data['production']['client_id']
        self.client_secret = data['production']['client_secret']
        self.access_token = data['tokens']['access_token']
        self.refresh_token = data['tokens']['refresh_token']

    def _save_tokens(self, access_token: str, refresh_token: str):
        with open(self.secrets_path) as f:
            data = json.load(f)
        data['tokens']['access_token'] = access_token
        data['tokens']['refresh_token'] = refresh_token
        tmp = self.secrets_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(data, f, indent=2)
        import os
        os.rename(tmp, self.secrets_path)
        os.chmod(self.secrets_path, 0o600)
        self.access_token = access_token
        self.refresh_token = refresh_token

    def refresh_auth(self) -> bool:
        """Refresh the OAuth2 token."""
        try:
            body = (
                f"grant_type=refresh_token"
                f"&refresh_token={self.refresh_token}"
                f"&client_id={self.client_id}"
                f"&client_secret={self.client_secret}"
            ).encode()
            req = urllib.request.Request(
                "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
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

    def _api_call(self, method: str, endpoint: str, body: dict = None, retry: bool = True) -> dict:
        """Make an authenticated API call to QBO."""
        url = f"{self.base_url}/{endpoint}?minorversion=75"
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
                    return self._api_call(method, endpoint, body, retry=False)
            error_body = e.read().decode() if e.fp else str(e)
            raise RuntimeError(f"QBO API {e.code}: {error_body}")

    def query(self, sql: str) -> dict:
        """Run a QBO query."""
        import urllib.parse
        encoded = urllib.parse.quote(sql)
        return self._api_call("GET", f"query?query={encoded}")

    def create_purchase(self, txn: Dict) -> Dict:
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

        result = self._api_call("POST", "purchase", purchase)
        return result.get('Purchase', result)

    def create_spei_fee(self, fee: Dict, parent_txn: Dict) -> Dict:
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

        result = self._api_call("POST", "purchase", purchase)
        return result.get('Purchase', result)

    def create_deposit(self, txn: Dict) -> Dict:
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

        result = self._api_call("POST", "deposit", deposit)
        return result.get('Deposit', result)

    def create_transfer(self, txn: Dict) -> Dict:
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

        result = self._api_call("POST", "transfer", transfer)
        return result.get('Transfer', result)

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
                summary['errors'].append(
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
        # If dedup fails, proceed without it but log the error
        summary['errors'].append(f"Dedup check failed (proceeding anyway): {e}")
        summary['dedup_skipped'] = 0
        buckets_to_push = []
        if push_auto:
            buckets_to_push.append(('auto', results.get('auto', [])))
        if push_guess:
            buckets_to_push.append(('guess', results.get('guess', [])))

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
                if record_type == 'transfer':
                    result = client.create_transfer(txn)
                    qbo_id = result.get('Id', 'unknown')
                    summary['transfers_pushed'] += 1
                elif record_type == 'deposit':
                    result = client.create_deposit(txn)
                    qbo_id = result.get('Id', 'unknown')
                    summary['income_pushed'] += 1
                else:
                    result = client.create_purchase(txn)
                    qbo_id = result.get('Id', 'unknown')
                    summary['expenses_pushed'] += 1

                    # Push SPEI fees as separate records
                    for fee in txn.get('spei_fees', []):
                        fee_usd = fee.get('amount_usd', 0) or 0
                        if fee_usd > 0:
                            try:
                                client.create_spei_fee(fee, txn)
                                summary['expenses_pushed'] += 1
                            except Exception as fe:
                                summary['errors'].append(f"SPEI fee for {txn.get('date')}: {fe}")

                summary['details'].append({
                    'date': str(txn.get('date')),
                    'amount_usd': txn.get('amount_usd'),
                    'category': txn.get('category_name'),
                    'vendor': txn.get('vendor_name'),
                    'qbo_id': qbo_id,
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
        print("Usage: python qbo_push.py <csv_file> [--live]")
        sys.exit(1)

    csv_path = sys.argv[1]
    is_live = '--live' in sys.argv

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
