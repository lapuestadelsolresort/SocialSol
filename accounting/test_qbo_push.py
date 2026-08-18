import json
import sys
import tempfile
import unittest
import urllib.error
from datetime import date
from pathlib import Path
from unittest.mock import Mock, mock_open, patch

sys.path.insert(0, str(Path(__file__).parent))

from qbo_push import (  # noqa: E402
    QBOClient, allocate_receipt_item_usd, find_missing_spei_fees,
    kapital_transaction_token, push_classified_to_qbo, qbo_record_type,
    qbo_request_id, verify_principal_readback, verify_receipt_purchase_readback,
)


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

    def test_transaction_time_and_code_disambiguate_request_identity(self):
        base = {
            'date': '2026-08-10', 'time': '10:00:00', 'operation': 'OP-1',
            'transaction_code': '000001', 'reference': '', 'amount': 53.40,
            'direction': 'credit', 'category': 'bank_interest',
        }
        other = {**base, 'transaction_code': '000002'}
        self.assertNotEqual(kapital_transaction_token(base), kapital_transaction_token(other))
        self.assertNotEqual(qbo_request_id(base, 'deposit'), qbo_request_id(other, 'deposit'))

    def test_record_type_refuses_a_credit_purchase(self):
        record_type, reason = qbo_record_type({
            'direction': 'credit', 'category': 'supplies', 'expense_refund': False,
        })
        self.assertIsNone(record_type)
        self.assertIn('not configured', reason)

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
        client._resolve_bank_account_id = lambda _key: '115'
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

    def test_legacy_receipt_readback_uses_durable_receipt_marker(self):
        transaction = {
            'amount_usd': 62.41, 'receipt_id': 'receipt-susy-1088',
            'payment_reference': None,
            'receipt_items': [
                {'amount': 87.09, 'category_key': 'supplies'},
                {'amount': 1000, 'category_key': 'cleaning_services'},
            ],
        }
        purchase = {
            'TotalAmt': 62.41,
            'PrivateNote': 'Reconciled receipt reimbursement receipt-susy-1088',
            'Line': [
                {
                    'Amount': 5,
                    'DetailType': 'AccountBasedExpenseLineDetail',
                    'AccountBasedExpenseLineDetail': {'AccountRef': {'value': '10'}},
                },
                {
                    'Amount': 57.41,
                    'DetailType': 'AccountBasedExpenseLineDetail',
                    'AccountBasedExpenseLineDetail': {'AccountRef': {'value': '11'}},
                },
            ],
        }
        config = {'qbo_accounts': {'expenses': {
            'supplies': {'id': '10'}, 'cleaning_services': {'id': '11'},
        }}}
        with patch('builtins.open', mock_open(read_data=json.dumps(config))):
            verify_receipt_purchase_readback(transaction, purchase)

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

    def test_query_refreshes_a_stale_access_token_before_retry(self):
        seen_tokens = []
        expired = urllib.error.HTTPError('https://quickbooks.example', 401, 'expired', {}, None)

        def fake_urlopen(request, timeout=0):
            seen_tokens.append(request.get_header('Authorization'))
            if len(seen_tokens) == 1:
                raise expired
            return FakeResponse({'QueryResponse': {}})

        client = self.client()

        def refresh():
            client.access_token = 'refreshed-token'
            return True

        client.refresh_auth = refresh
        try:
            with patch('urllib.request.urlopen', fake_urlopen):
                result = client.query('SELECT Id FROM Purchase MAXRESULTS 1')
        finally:
            expired.close()
        self.assertEqual(result, {'QueryResponse': {}})
        self.assertEqual(seen_tokens, ['Bearer token', 'Bearer refreshed-token'])

    def test_qbo_write_fails_before_create_when_dedup_cannot_be_verified(self):
        client = Mock()
        client.query.side_effect = RuntimeError('QBO unavailable')
        results = {
            'auto': [{
                'date': date(2026, 8, 6), 'amount': 5000, 'amount_usd': 290.19,
                'currency': 'MXN', 'reference': 'Clave: 136-06/08/2026/06-1',
                'category': 'contract_labor', 'category_name': 'Contract Labor',
            }],
            'guess': [],
            'unknown': [],
        }
        with patch('qbo_push.QBOClient', return_value=client):
            with self.assertRaisesRegex(RuntimeError, 'dedup preflight failed'):
                push_classified_to_qbo(results, dry_run=False)
        client.create_purchase.assert_not_called()

    def test_qbo_summary_distinguishes_unrecorded_holds_from_recorded_review_items(self):
        client = Mock()
        client.query.return_value = {'QueryResponse': {}}
        results = {
            'auto': [],
            'guess': [{
                'date': date(2026, 8, 6), 'amount': 2105, 'amount_usd': 122.17, 'currency': 'MXN',
                'direction': 'debit',
                'reason': 'duplicate reimbursement requires review',
            }],
            'unknown': [{
                'date': date(2026, 8, 10), 'amount': 2499, 'amount_usd': 146.48, 'currency': 'MXN',
                'direction': 'debit',
                'reason': 'manual classification required',
            }],
        }
        with patch('qbo_push.QBOClient', return_value=client):
            held = push_classified_to_qbo(results, dry_run=True)
            recorded = push_classified_to_qbo(results, record_unresolved=True, dry_run=True)
        self.assertEqual(held['held'], 2)
        self.assertEqual(held['review_required'], 0)
        self.assertEqual([row['amount'] for row in held['held_details']], [2105, 2499])
        self.assertEqual(recorded['held'], 0)
        self.assertEqual(recorded['review_required'], 2)
        self.assertEqual([row['amount'] for row in recorded['review_details']], [2105, 2499])
        self.assertTrue(all(row['category_key'] == 'uncategorized_expense'
                            for row in recorded['review_details']))

    def test_mercadolibre_credit_dry_run_is_a_deposit_not_an_expense(self):
        client = Mock()
        client.query.return_value = {'QueryResponse': {}}
        transaction = {
            'date': date(2026, 6, 4), 'time': '09:40:00',
            'operation': '0642431832000', 'transaction_code': '000066',
            'description': 'ABONO', 'reference': 'MERPAGO MERCADOLIBRE',
            'direction': 'credit', 'amount': 490, 'amount_usd': 28.44,
            'currency': 'MXN', 'category': 'supplies',
            'category_name': 'Supplies (refund)', 'expense_refund': True,
        }
        with patch('qbo_push.QBOClient', return_value=client):
            summary = push_classified_to_qbo(
                {'auto': [transaction], 'guess': [], 'unknown': []}, dry_run=True,
            )
        self.assertEqual(summary['income_pushed'], 1)
        self.assertEqual(summary['expenses_pushed'], 0)
        self.assertEqual(summary['details'][0]['record_type'], 'deposit')
        self.assertTrue(summary['complete'])

    def test_unmarked_credit_is_held_instead_of_written_as_a_purchase(self):
        client = Mock()
        client.query.return_value = {'QueryResponse': {}}
        transaction = {
            'date': date(2026, 6, 4), 'description': 'ABONO', 'reference': '',
            'direction': 'credit', 'amount': 490, 'amount_usd': 28.44,
            'currency': 'MXN', 'category': 'supplies', 'expense_refund': False,
        }
        with patch('qbo_push.QBOClient', return_value=client):
            summary = push_classified_to_qbo(
                {'auto': [transaction], 'guess': [], 'unknown': []}, dry_run=True,
            )
        self.assertEqual(summary['expenses_pushed'], 0)
        self.assertEqual(summary['income_pushed'], 0)
        self.assertEqual(summary['held'], 1)
        self.assertFalse(summary['complete'])

    def test_month_end_timbrado_pair_is_counted_as_an_intentional_subcent_skip(self):
        client = Mock()
        client.query.return_value = {'QueryResponse': {}}
        base = {
            'date': date(2026, 6, 30), 'time': '22:46:00',
            'operation': '0652451075000', 'amount': 0.01, 'amount_usd': 0.0,
            'currency': 'MXN', 'category': 'bank_fee',
        }
        transactions = [
            {**base, 'description': 'Comisión por timbrado fiscal',
             'direction': 'debit', 'transaction_code': '000054'},
            {**base, 'description': 'Descuento por timbrado fiscal',
             'direction': 'credit', 'transaction_code': '000055', 'expense_refund': True},
        ]
        with patch('qbo_push.QBOClient', return_value=client):
            summary = push_classified_to_qbo(
                {'auto': transactions, 'guess': [], 'unknown': []}, dry_run=True,
            )
        self.assertEqual(summary['intentional_skipped'], 2)
        self.assertEqual(summary['held'], 0)
        self.assertEqual(summary['principal_recorded'], 2)
        self.assertTrue(summary['complete'])

    def test_owner_transfer_without_exact_bofa_amount_is_held(self):
        client = Mock()
        client.query.return_value = {'QueryResponse': {}}
        transaction = {
            'date': date(2026, 7, 22), 'description': '(NB) RECEPCION DE CUENTA',
            'reference': '', 'direction': 'credit', 'amount': 850,
            'amount_usd': 49.33, 'currency': 'MXN', 'category': 'owner_transfer',
        }
        with patch('qbo_push.QBOClient', return_value=client):
            summary = push_classified_to_qbo(
                {'auto': [transaction], 'guess': [], 'unknown': []}, dry_run=True,
            )
        self.assertEqual(summary['transfers_pushed'], 0)
        self.assertEqual(summary['held'], 1)
        self.assertIn('Exact USD transfer amount', summary['held_details'][0]['review_reason'])

    def test_spei_fee_reconciliation_consumes_legacy_lines_as_a_multiset(self):
        parents = [
            {
                'date': date(2026, 8, 6), 'amount': amount, 'amount_usd': amount / 17.23,
                'reference': f'Clave: 136-06/08/2026/06-{index}',
                'vendor_name': vendor,
                'spei_fees': [
                    {'amount': 4, 'amount_usd': 0.23, 'is_spei_iva': False},
                    {'amount': 0.64, 'amount_usd': 0.04, 'is_spei_iva': True},
                ],
            }
            for index, (amount, vendor) in enumerate([
                (2800, 'Sergio Gracia'), (5000, 'Sergio Gracia'),
                (3000, 'Sergio Gracia'), (2105, 'Sergio Gracia'),
                (4700, 'Ignacio Rubio'),
            ], start=1)
        ]
        purchases = []
        qbo_id = 100
        for _ in range(3):
            for kind, total in [('Commission', 0.23), ('IVA', 0.04)]:
                purchases.append({
                    'Id': str(qbo_id), 'TxnDate': '2026-08-06', 'TotalAmt': total,
                    'PrivateNote': f'SPEI {kind} on transfer to Sergio Gracia | FX: 17.23 MXN/USD',
                })
                qbo_id += 1

        missing, existing = find_missing_spei_fees(
            parents,
            lambda _sql: {'QueryResponse': {'Purchase': purchases}},
        )
        self.assertEqual(len(existing), 6)
        self.assertEqual(len(missing), 4)
        self.assertEqual(
            [(item['parent']['amount'], item['kind']) for item in missing],
            [(2105, 'commission'), (2105, 'iva'), (4700, 'commission'), (4700, 'iva')],
        )

    def test_legacy_embedded_fee_lines_count_as_already_recorded(self):
        """F-039: pre-cutover records carry SPEI fees as Bank Fee split lines
        inside the parent Purchase. The standalone matcher could not see them,
        so re-processing a legacy statement would have pushed a duplicate,
        standalone copy of every embedded fee."""
        parent = {
            'date': date(2026, 7, 22), 'amount': 25000, 'amount_usd': 1450.96,
            'reference': 'Clave: 136-22/07/2026/22-9911',
            'vendor_name': 'Sergio Gracia',
            'spei_fees': [
                {'amount': 6, 'amount_usd': 0.35, 'is_spei_iva': False},
                {'amount': 0.96, 'amount_usd': 0.06, 'is_spei_iva': True},
            ],
        }
        legacy_purchase = {
            'Id': '2365', 'TxnDate': '2026-07-22', 'TotalAmt': 1451.37,
            'PrivateNote': 'SPEI to Sergio Gracia | Clave: 136-22/07/2026/22-9911',
            'EntityRef': {'name': 'Sergio Gracia'},
            'Line': [
                {'Amount': 1450.96, 'AccountBasedExpenseLineDetail': {
                    'AccountRef': {'value': '1150040020', 'name': 'Contract Labor'}}},
                {'Amount': 0.35, 'AccountBasedExpenseLineDetail': {
                    'AccountRef': {'value': '1150040012', 'name': 'Bank Fee'}}},
                {'Amount': 0.06, 'AccountBasedExpenseLineDetail': {
                    'AccountRef': {'value': '1150040012', 'name': 'Bank Fee'}}},
            ],
        }

        missing, existing = find_missing_spei_fees(
            [parent],
            lambda _sql: {'QueryResponse': {'Purchase': [legacy_purchase]}},
        )
        self.assertEqual(missing, [])
        self.assertEqual(len(existing), 2)
        self.assertEqual({item['source'] for item in existing}, {'embedded_line'})
        self.assertEqual({item['qbo_id'] for item in existing}, {'2365'})

    def test_embedded_fee_lines_are_consumed_once_each(self):
        """Two same-amount fees on one day need two embedded lines, not one."""
        parents = [
            {
                'date': date(2026, 7, 22), 'amount': 25000, 'amount_usd': 1450.96,
                'reference': f'Clave: 136-22/07/2026/22-{index}',
                'vendor_name': 'Sergio Gracia',
                'spei_fees': [{'amount': 6, 'amount_usd': 0.35, 'is_spei_iva': False}],
            }
            for index in (1, 2)
        ]
        one_line_only = {
            'Id': '2365', 'TxnDate': '2026-07-22', 'TotalAmt': 1451.31,
            'PrivateNote': 'SPEI to Sergio Gracia',
            'EntityRef': {'name': 'Sergio Gracia'},
            'Line': [
                {'Amount': 0.35, 'AccountBasedExpenseLineDetail': {
                    'AccountRef': {'value': '1150040012', 'name': 'Bank Fee'}}},
            ],
        }

        missing, existing = find_missing_spei_fees(
            parents,
            lambda _sql: {'QueryResponse': {'Purchase': [one_line_only]}},
        )
        self.assertEqual(len(existing), 1)
        self.assertEqual(len(missing), 1)

    def test_unrelated_bank_fee_lines_do_not_absorb_a_fee(self):
        """A Bank Fee line on a different day or amount is not this fee."""
        parent = {
            'date': date(2026, 7, 22), 'amount': 25000, 'amount_usd': 1450.96,
            'reference': 'Clave: 136-22/07/2026/22-9911',
            'vendor_name': 'Sergio Gracia',
            'spei_fees': [{'amount': 6, 'amount_usd': 0.35, 'is_spei_iva': False}],
        }
        unrelated = {
            'Id': '9000', 'TxnDate': '2026-07-21', 'TotalAmt': 0.35,
            'PrivateNote': 'monthly account fee',
            'EntityRef': {'name': 'Kapital'},
            'Line': [
                {'Amount': 0.35, 'AccountBasedExpenseLineDetail': {
                    'AccountRef': {'value': '1150040012', 'name': 'Bank Fee'}}},
            ],
        }
        wrong_amount = {
            'Id': '9001', 'TxnDate': '2026-07-22', 'TotalAmt': 12.00,
            'PrivateNote': 'SPEI to Sergio Gracia | Clave: 136-22/07/2026/22-9911',
            'EntityRef': {'name': 'Sergio Gracia'},
            'Line': [
                {'Amount': 12.00, 'AccountBasedExpenseLineDetail': {
                    'AccountRef': {'value': '1150040012', 'name': 'Bank Fee'}}},
            ],
        }

        missing, existing = find_missing_spei_fees(
            [parent],
            lambda _sql: {'QueryResponse': {'Purchase': [unrelated, wrong_amount]}},
        )
        self.assertEqual(existing, [])
        self.assertEqual(len(missing), 1)

    def test_standalone_records_still_win_over_embedded_lines(self):
        """The modern format keeps its exact parent-reference binding."""
        parent = {
            'date': date(2026, 8, 6), 'amount': 2800, 'amount_usd': 162.51,
            'reference': 'Clave: 136-06/08/2026/06-1',
            'vendor_name': 'Sergio Gracia',
            'spei_fees': [{'amount': 4, 'amount_usd': 0.23, 'is_spei_iva': False}],
        }
        standalone = {
            'Id': '500', 'TxnDate': '2026-08-06', 'TotalAmt': 0.23,
            'PrivateNote': 'SPEI Commission on transfer to Sergio Gracia | Parent ref: Clave: 136-06/08/2026/06-1',
        }

        missing, existing = find_missing_spei_fees(
            [parent],
            lambda _sql: {'QueryResponse': {'Purchase': [standalone]}},
        )
        self.assertEqual(missing, [])
        self.assertEqual(len(existing), 1)
        self.assertEqual(existing[0]['source'], 'standalone')
        self.assertEqual(existing[0]['qbo_id'], '500')

    def test_new_spei_fee_memo_is_bound_to_exact_parent_reference(self):
        client = self.client()
        client._resolve_account_id = lambda _key: '1150040012'
        client._resolve_vendor_id = lambda _key: '16'
        client._resolve_bank_account_id = lambda _key: '115'
        seen = []
        client._api_call = lambda method, endpoint, body, request_id=None: (
            seen.append(body) or {'Purchase': {'Id': '42'}}
        )
        parent = {
            'date': date(2026, 8, 13), 'amount': 7500, 'fx_rate': 17.06,
            'reference': 'Clave: 136-13/08/2026/13-1704637578',
            'vendor_name': 'The Tequila Experience',
        }
        client.create_spei_fee(
            {'amount': 4, 'amount_usd': 0.23, 'is_spei_iva': False}, parent,
        )
        self.assertIn(parent['reference'], seen[0]['PrivateNote'])
        self.assertIn('Parent orig $7,500.00 MXN', seen[0]['PrivateNote'])

    def test_expense_refund_deposit_posts_back_to_the_expense_account(self):
        client = self.client()
        client._resolve_bank_account_id = lambda key: {'kapital': '115'}[key]
        client._resolve_account_id = lambda key: {'supplies': '42'}[key]
        client._resolve_income_account_id = Mock(side_effect=AssertionError('income account not expected'))
        seen = []
        client._api_call = lambda method, endpoint, body, request_id=None: (
            seen.append(body) or {'Deposit': {'Id': '500'}}
        )
        transaction = {
            'date': date(2026, 6, 4), 'time': '09:40:00', 'operation': 'OP-1',
            'transaction_code': '000066', 'direction': 'credit', 'amount': 490,
            'amount_usd': 28.44, 'category': 'supplies', 'expense_refund': True,
            'description': 'ABONO', 'reference': 'MERPAGO MERCADOLIBRE',
        }
        client.create_deposit(transaction)
        deposit = seen[0]
        self.assertEqual(deposit['DepositToAccountRef']['value'], '115')
        self.assertEqual(deposit['Line'][0]['DepositLineDetail']['AccountRef']['value'], '42')
        self.assertIn('MERPAGO MERCADOLIBRE', deposit['PrivateNote'])
        self.assertIn('Kapital txn:', deposit['PrivateNote'])

    def test_fx_transfer_uses_the_exact_executed_usd_amount(self):
        client = self.client()
        client._resolve_bank_account_id = lambda key: {'bofa': '9', 'kapital': '115'}[key]
        seen = []
        client._api_call = lambda method, endpoint, body, request_id=None: (
            seen.append(body) or {'Transfer': {'Id': '501'}}
        )
        client.create_transfer({
            'date': date(2026, 7, 30), 'direction': 'credit', 'amount': 127800,
            'transfer_amount_usd': 7500, 'fx_rate': 17.04,
            'category': 'fx_conversion', 'transaction_code': '000100',
        })
        self.assertEqual(seen[0]['Amount'], 7500)
        self.assertEqual(seen[0]['FromAccountRef']['value'], '9')
        self.assertEqual(seen[0]['ToAccountRef']['value'], '115')

    def test_purchase_readback_verifies_the_expense_posting_account(self):
        client = self.client()
        client._resolve_bank_account_id = lambda _key: '115'
        client._resolve_account_id = lambda _key: '42'
        transaction = {
            'date': date(2026, 8, 10), 'direction': 'debit', 'amount': 100,
            'amount_usd': 5.80, 'category': 'supplies',
        }
        purchase = {
            'TotalAmt': 5.80, 'AccountRef': {'value': '115'},
            'PrivateNote': f"Kapital txn: {kapital_transaction_token(transaction)}",
            'Line': [{
                'DetailType': 'AccountBasedExpenseLineDetail', 'Amount': 5.80,
                'AccountBasedExpenseLineDetail': {'AccountRef': {'value': '99'}},
            }],
        }
        with self.assertRaisesRegex(RuntimeError, 'posting account'):
            verify_principal_readback(client, transaction, 'expense', purchase)

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

    def test_refresh_reuses_a_token_rotated_by_another_process(self):
        with tempfile.TemporaryDirectory() as directory:
            secret = Path(directory) / 'quickbooks.json'
            secret.write_text(json.dumps({
                'realmId': 'realm', 'access_token': 'stale-access',
                'refresh_token': 'stale-refresh', 'env': 'sandbox',
            }))
            (Path(directory) / 'quickbooks-dev.json').write_text(json.dumps({
                'client_id': 'client', 'client_secret': 'secret',
            }))
            client = QBOClient(str(secret))
            secret.write_text(json.dumps({
                'realmId': 'realm', 'access_token': 'fresh-access',
                'refresh_token': 'fresh-refresh', 'env': 'sandbox',
            }))
            with patch('urllib.request.urlopen') as urlopen:
                self.assertTrue(client.refresh_auth())
            urlopen.assert_not_called()
            self.assertEqual(client.access_token, 'fresh-access')


if __name__ == '__main__':
    unittest.main()
