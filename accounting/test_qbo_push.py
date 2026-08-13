import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from qbo_push import QBOClient, allocate_receipt_item_usd, qbo_request_id  # noqa: E402


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


class QBOIntegrityTests(unittest.TestCase):
    def client(self):
        client = object.__new__(QBOClient)
        client.base_url = 'https://quickbooks.example/v3/company/realm'
        client.access_token = 'token'
        return client

    def test_request_id_is_stable_non_pii_and_within_provider_limit(self):
        txn = {
            'date': '2026-08-10', 'reference': 'CLAVE-123', 'amount': 1250,
            'category': 'maintenance', 'description': 'Private vendor name',
        }
        first = qbo_request_id(txn, 'expense')
        self.assertEqual(first, qbo_request_id(txn, 'expense'))
        self.assertLessEqual(len(first), 50)
        self.assertNotIn('CLAVE', first)
        self.assertNotEqual(first, qbo_request_id(txn, 'expense', 'spei-1'))

    def test_receipt_split_allocates_exact_parent_total(self):
        items = [{'amount': amount} for amount in [340, 30, 220, 815, 700]]
        allocated = allocate_receipt_item_usd(118.53, items)
        self.assertEqual(round(sum(allocated), 2), 118.53)
        self.assertEqual(len(allocated), 5)

    def test_receipt_purchase_builds_one_qbo_line_per_classified_item(self):
        client = self.client()
        client._resolve_account_id = lambda key: {
            'maintenance': '10', 'cleaning_services': '11',
        }.get(key)
        client._resolve_vendor_id = lambda _key: '20'
        seen = []
        client._api_call = lambda method, endpoint, body, request_id=None: (
            seen.append((method, endpoint, body, request_id)) or {'Purchase': {'Id': '42'}}
        )
        transaction = {
            'date': '2026-08-20', 'amount': 2105, 'amount_usd': 118.53,
            'category': 'receipt_bundle', 'vendor_key': 'sergio_gracia',
            'description': 'LPDSRA1B2C3D4E5F60718', 'payment_reference': 'LPDSRA1B2C3D4E5F60718',
            'receipt_items': [
                {'item_index': 1, 'amount': 1405, 'category_key': 'maintenance', 'vendor': 'Hardware'},
                {'item_index': 2, 'amount': 700, 'category_key': 'cleaning_services', 'vendor': 'Cleaner'},
            ],
        }
        client.create_purchase(transaction, request_id='receipt-request')
        purchase = seen[0][2]
        self.assertEqual(purchase['TotalAmt'], 118.53)
        self.assertEqual([line['AccountBasedExpenseLineDetail']['AccountRef']['value']
                          for line in purchase['Line']], ['10', '11'])
        self.assertEqual(round(sum(line['Amount'] for line in purchase['Line']), 2), 118.53)
        self.assertIn('LPDSRA1B2C3D4E5F60718', purchase['PrivateNote'])

    def test_provider_request_id_is_sent_on_create(self):
        seen = []

        def fake_urlopen(request, timeout=0):
            seen.append((request.full_url, timeout))
            return FakeResponse({'Purchase': {'Id': '42'}})

        client = self.client()
        with patch('urllib.request.urlopen', fake_urlopen):
            result = client._api_call(
                'POST', 'purchase', {'TotalAmt': 1}, request_id='stable-request-1'
            )
        self.assertEqual(result['Purchase']['Id'], '42')
        self.assertIn('requestid=stable-request-1', seen[0][0])
        self.assertIn('minorversion=75', seen[0][0])

    def test_entity_readback_uses_canonical_endpoint(self):
        seen = []

        def fake_urlopen(request, timeout=0):
            seen.append(request.full_url)
            return FakeResponse({'Purchase': {'Id': '42'}})

        client = self.client()
        with patch('urllib.request.urlopen', fake_urlopen):
            result = client.read_entity('purchase', '42')
        self.assertEqual(result['Id'], '42')
        self.assertIn('/purchase/42?', seen[0])

    def test_journal_entry_create_and_readback_use_canonical_endpoints(self):
        seen = []

        def fake_urlopen(request, timeout=0):
            seen.append((request.method, request.full_url))
            if request.method == 'POST':
                return FakeResponse({'JournalEntry': {'Id': '9001'}})
            return FakeResponse({'JournalEntry': {'Id': '9001', 'Line': []}})

        client = self.client()
        with patch('urllib.request.urlopen', fake_urlopen):
            created = client.create_journal_entry({'Line': []}, request_id='owner-expense-1')
            readback = client.read_entity('journalentry', created['Id'])
        self.assertEqual(readback['Id'], '9001')
        self.assertIn('/journalentry?', seen[0][1])
        self.assertIn('requestid=owner-expense-1', seen[0][1])
        self.assertIn('/journalentry/9001?', seen[1][1])

    def test_legacy_secret_schema_is_loaded_without_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / 'quickbooks.json'
            secret.write_text(json.dumps({
                'realm_id': 'realm',
                'production': {'client_id': 'client', 'client_secret': 'secret'},
                'tokens': {'access_token': 'access', 'refresh_token': 'refresh'},
            }))
            client = QBOClient(str(secret))
            self.assertEqual(client.realm_id, 'realm')
            self.assertEqual(client.access_token, 'access')
            self.assertIn('/v3/company/realm', client.base_url)

    def test_flat_secret_schema_uses_companion_app_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / 'quickbooks.json'
            secret.write_text(json.dumps({
                'realmId': 'realm', 'access_token': 'access',
                'refresh_token': 'refresh', 'env': 'sandbox',
            }))
            (Path(directory) / 'quickbooks-dev.json').write_text(json.dumps({
                'client_id': 'client', 'client_secret': 'secret',
            }))
            client = QBOClient(str(secret))
            self.assertEqual(client.client_id, 'client')
            self.assertIn('sandbox-quickbooks', client.base_url)


if __name__ == '__main__':
    unittest.main()
