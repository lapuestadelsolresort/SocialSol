import sqlite3
import tempfile
import unittest
from pathlib import Path

from campaign_measurement import squarespace_commerce_metrics


class SquarespaceCommerceMetricsTests(unittest.TestCase):
    def test_reports_direct_commerce_without_campaign_attribution(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "crm.db"
            con = sqlite3.connect(db_path)
            con.executescript("""
                CREATE TABLE squarespace_orders (
                  order_id TEXT PRIMARY KEY, created_on TEXT, grand_total_value TEXT
                );
                CREATE TABLE squarespace_payments (
                  payment_id TEXT PRIMARY KEY, paid_on TEXT, amount_value TEXT
                );
                CREATE TABLE squarespace_processing_fees (
                  fee_id TEXT PRIMARY KEY, payment_id TEXT, amount_value TEXT,
                  refunded_amount_value TEXT
                );
                CREATE TABLE squarespace_refunds (
                  refund_id TEXT PRIMARY KEY, refunded_on TEXT, amount_value TEXT
                );
                CREATE TABLE squarespace_order_ownerrez_links (
                  order_id TEXT PRIMARY KEY, status TEXT
                );
                INSERT INTO squarespace_orders VALUES ('o1','2026-08-10 18:00:00','1000.00');
                INSERT INTO squarespace_payments VALUES ('p1','2026-08-10 18:01:00','1000.00');
                INSERT INTO squarespace_processing_fees VALUES ('f1','p1','30.00','2.00');
                INSERT INTO squarespace_refunds VALUES ('r1','2026-08-10 19:00:00','100.00');
                INSERT INTO squarespace_order_ownerrez_links VALUES ('o1','matched');
            """)
            con.commit()
            con.close()
            result = squarespace_commerce_metrics(db_path, "2026-08-10")
            self.assertTrue(result["available"])
            self.assertEqual(result["orders"], 1)
            self.assertEqual(result["collected"], 1000.0)
            self.assertEqual(result["fees"], 30.0)
            self.assertEqual(result["refunded_fees"], 2.0)
            self.assertEqual(result["refunds"], 100.0)
            self.assertEqual(result["net_after_fees_and_refunds"], 872.0)
            self.assertEqual(result["ownerrez_exceptions"], 0)


if __name__ == "__main__":
    unittest.main()
