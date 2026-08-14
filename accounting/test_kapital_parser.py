import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from kapital_parser import _group_spei_triplets, parse_kapital_csv  # noqa: E402


HEADER = "\n".join([
    ',,,Estado de Cuenta de Cheques Kapital Bank',
    ',,,RIVIERA PUESTA DEL SOL VILLAS S.A. DE C.V.',
    ',,,RFC: TEST010101AA1',
    ',,,Saldo Inicial,,,,,,,,_1000.00',
    ',FECHA,HORA,DESCRIPCION,REFERENCIA,ORIGEN,SUCURSAL,CARGOS,ABONOS,SALDO,OPERACION,TRANSACCION',
])


def row(description, debit='', credit='', balance='1000.00', operation='OP-1', code='400000'):
    return (
        f',_01082026,_10:00:00,_{description},,_000668,_170,'
        f'_{debit},_{credit},_{balance},_{operation},_{code},'
    )


class KapitalParserIntegrityTests(unittest.TestCase):
    def parse_bytes(self, payload):
        with tempfile.TemporaryDirectory() as directory:
            statement = Path(directory) / 'statement.csv'
            statement.write_bytes(payload)
            return parse_kapital_csv(str(statement))

    def test_cp1252_accents_and_balances_are_preserved(self):
        statement = '\n'.join([
            HEADER,
            row(
                'Envio SPEI AZTECA | VENDOR Dato no verificado | 123 | 7654321 | SERVICIO | KAPITAL |',
                debit='100.00', balance='900.00', operation='OP-1', code='400000',
            ),
            row(
                'Comisión Transferencia - envío ; (SPEI)', debit='4.00',
                balance='896.00', operation='OP-1', code='400001',
            ),
        ])
        metadata, transactions = self.parse_bytes(statement.encode('cp1252'))
        self.assertEqual(metadata['encoding'], 'cp1252')
        self.assertTrue(metadata['balance_reconciled'])
        self.assertEqual(metadata['closing_balance'], 896.00)
        self.assertEqual(metadata['transaction_count'], 2)
        self.assertEqual(len(transactions), 1)
        self.assertEqual(transactions[0]['spei_fees'][0]['description'], 'Comisión Transferencia - envío ; (SPEI)')

    def test_running_balance_mismatch_rejects_the_statement(self):
        statement = '\n'.join([
            HEADER,
            row('CARD PURCHASE', debit='10.00', balance='991.00'),
        ])
        with self.assertRaisesRegex(ValueError, 'balance validation failed'):
            self.parse_bytes(statement.encode())

    def test_small_opening_balance_is_still_reconciled(self):
        statement = '\n'.join([
            HEADER.replace('_1000.00', '_50.00'),
            row('BANK CREDIT', credit='5.00', balance='55.00'),
        ])
        metadata, _transactions = self.parse_bytes(statement.encode())
        self.assertEqual(metadata['opening_balance'], 50.00)
        self.assertEqual(metadata['closing_balance'], 55.00)
        self.assertTrue(metadata['balance_reconciled'])

    def test_missing_opening_balance_rejects_the_statement(self):
        statement = '\n'.join([
            HEADER.replace(',,,Saldo Inicial,,,,,,,,_1000.00\n', ''),
            row('CARD PURCHASE', debit='10.00', balance='990.00'),
        ])
        with self.assertRaisesRegex(ValueError, 'opening balance is missing'):
            self.parse_bytes(statement.encode())

    def test_unparseable_final_transaction_row_is_not_silently_dropped(self):
        statement = '\n'.join([
            HEADER,
            ',_BADDATE,_10:00:00,_CARD PURCHASE,,_000668,_170,_10.00,,_990.00,_OP-1,_600030,',
        ])
        with self.assertRaisesRegex(ValueError, 'could not be parsed'):
            self.parse_bytes(statement.encode())

    def test_empty_operation_and_transaction_fields_keep_column_alignment(self):
        statement = '\n'.join([
            HEADER,
            row('CARD PURCHASE', debit='10.00', balance='990.00', operation='', code=''),
        ])
        metadata, transactions = self.parse_bytes(statement.encode())
        self.assertTrue(metadata['balance_reconciled'])
        self.assertEqual(transactions[0]['direction'], 'debit')
        self.assertEqual(transactions[0]['operation'], '')
        self.assertEqual(transactions[0]['transaction_code'], '')

    def test_fee_is_not_attached_to_a_different_operation(self):
        transfer = {
            'spei': {'direction': 'out'}, 'is_spei_fee': False, 'is_spei_iva': False,
            'operation': 'OP-1', 'amount': 100,
        }
        fee = {
            'spei': None, 'is_spei_fee': True, 'is_spei_iva': False,
            'operation': 'OP-2', 'amount': 4,
        }
        grouped = _group_spei_triplets([transfer, fee])
        self.assertEqual(transfer['spei_fees'], [])
        self.assertTrue(grouped[1]['_standalone_fee'])


if __name__ == '__main__':
    unittest.main()
