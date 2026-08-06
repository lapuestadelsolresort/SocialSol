"""
Kapital Transaction Classifier

Classifies parsed Kapital transactions into QBO categories using
a tiered rule engine. Produces three buckets:
  - auto: high-confidence matches
  - guess: likely match, needs confirmation
  - unknown: needs human review
"""

import re
import json
from datetime import date, datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple


class KapitalClassifier:
    """Rule-based classifier for Kapital bank transactions."""

    def __init__(self, config_path: str = None):
        if config_path is None:
            config_path = str(Path(__file__).parent / 'config.json')
        with open(config_path) as f:
            self.config = json.load(f)

        self.accounts = self.config['qbo_accounts']['expenses']
        self.vendors = self.config['vendors']
        self.salary_patterns = self.config['salary_patterns']

    def classify_all(self, transactions: List[Dict]) -> Dict[str, List[Dict]]:
        """
        Classify a list of transactions.
        Returns { 'auto': [...], 'guess': [...], 'unknown': [...] }
        """
        results = {'auto': [], 'guess': [], 'unknown': []}

        for txn in transactions:
            classified = self.classify(txn)
            bucket = classified['confidence']
            results[bucket].append(classified)

        return results

    def classify(self, txn: Dict) -> Dict:
        """
        Classify a single transaction.
        Returns the transaction dict augmented with:
          - category: QBO account key
          - category_name: human-readable name
          - vendor_key: vendor config key (or None)
          - vendor_name: human-readable vendor name
          - confidence: 'auto' | 'guess' | 'unknown'
          - reason: why this classification was chosen
          - note: optional memo for QBO
          - needs_channel_check: list of channel IDs to cross-reference
        """
        result = {
            **txn,
            'category': None,
            'category_name': None,
            'vendor_key': None,
            'vendor_name': None,
            'confidence': 'unknown',
            'reason': '',
            'note': '',
            'needs_channel_check': [],
        }

        # Skip standalone fee/IVA lines (they're grouped under parent)
        if txn.get('_standalone_fee'):
            result['category'] = 'bank_fee'
            result['category_name'] = 'Bank Fee'
            result['vendor_key'] = 'kapital'
            result['vendor_name'] = 'Kapital Mexico'
            result['confidence'] = 'auto'
            result['reason'] = 'Standalone SPEI fee'
            return result

        # Handle SPEI fee/IVA lines attached to parent
        if txn.get('is_spei_fee') or txn.get('is_spei_iva'):
            result['category'] = 'bank_fee'
            result['category_name'] = 'Bank Fee'
            result['vendor_key'] = 'kapital'
            result['vendor_name'] = 'Kapital Mexico'
            result['confidence'] = 'auto'
            result['reason'] = 'SPEI fee/IVA'
            return result

        desc = txn.get('description', '')
        ref = txn.get('reference', '')
        desc_upper = desc.upper()
        ref_upper = ref.upper()
        # Combined text for keyword matching (description + reference)
        full_text = f"{desc_upper} {ref_upper}"
        amount = txn.get('amount', 0)
        direction = txn.get('direction', '')
        spei = txn.get('spei')
        raw_concept = spei.get('concept', '') if spei else ''
        # Clean concept: strip leading ref numbers and pipe separators
        concept = re.sub(r'^[\d\s|]+', '', raw_concept).strip().upper()
        payee = spei.get('payee', '').upper() if spei else ''

        # === INCOME (credits) ===
        if direction == 'credit':
            return self._classify_income(result, desc_upper, amount, spei, concept, payee, full_text)

        # === EXPENSES (debits) ===
        # Tier 1: Exact pattern matches
        tier1 = self._tier1_exact(result, desc_upper, amount, spei, concept, payee, full_text, ref_upper)
        if tier1:
            return tier1

        # Tier 2: Pattern + keyword disambiguation
        tier2 = self._tier2_keyword(result, desc_upper, amount, spei, concept, payee)
        if tier2:
            return tier2

        # Tier 3: Unknown — ping Mayela for classification
        result['confidence'] = 'unknown'
        result['reason'] = f'No rule matched. Payee: {payee or "N/A"}, Concept: {concept or desc_upper[:60]}'
        result['needs_channel_check'] = self._suggest_channels(payee, concept)
        result['ping_mayela'] = True
        result['note'] = f'Ask Mayela: how should this be classified? ${amount:,.0f} MXN to {payee or "unknown"}'
        return result

    def _classify_income(self, result, desc_upper, amount, spei, concept, payee, full_text=''):
        """Classify credit (income) transactions."""
        if not full_text:
            full_text = desc_upper

        # DLOCAL = Airbnb payout
        if 'DLOCAL' in full_text:
            result['category'] = 'income_airbnb'
            result['category_name'] = 'Income - Airbnb'
            result['vendor_name'] = 'Airbnb (via DLocal/Payoneer)'
            result['confidence'] = 'auto'
            result['reason'] = 'DLOCAL Payoneer = Airbnb payout'
            return result

        # Owner transfer (Jason funding from BofA)
        if '(NB) RECEPCION DE CUENTA' in desc_upper or 'RECEPCION DE CUENTA' in desc_upper:
            result['category'] = 'owner_transfer'
            result['category_name'] = 'Owner Transfer In'
            result['confidence'] = 'auto'
            result['reason'] = 'Internal transfer from BofA'
            result['note'] = 'Jason funding Kapital from BofA'
            return result

        # FX conversion
        if 'COMPRA DE DIVISAS' in desc_upper or 'DEPOSITO POR COMPRA' in desc_upper:
            result['category'] = 'fx_conversion'
            result['category_name'] = 'FX Conversion (USD→MXN)'
            result['confidence'] = 'auto'
            result['reason'] = 'Currency exchange deposit'
            # Extract USD amount and rate
            usd_match = re.search(r'(\d[\d, ]*\.?\d*)\s*USD', desc_upper)
            rate_match = re.search(r'TIPO DE CAMBIO DE\s+(\d+\.\d+)', desc_upper)
            if usd_match and rate_match:
                result['note'] = f"USD {usd_match.group(1).replace(' ', '')} @ {rate_match.group(1)}"
            return result

        # Bank interest
        if desc_upper.strip() == 'INTERES' or 'INTERES' in desc_upper:
            result['category'] = 'bank_interest'
            result['category_name'] = 'Bank Interest'
            result['vendor_key'] = 'kapital'
            result['vendor_name'] = 'Kapital Mexico'
            result['confidence'] = 'auto'
            result['reason'] = 'Monthly bank interest'
            return result

        # Fiscal stamp discount
        if 'DESCUENTO POR TIMBRADO' in desc_upper:
            result['category'] = 'bank_fee'
            result['category_name'] = 'Bank Fee (credit)'
            result['vendor_key'] = 'kapital'
            result['vendor_name'] = 'Kapital Mexico'
            result['confidence'] = 'auto'
            result['reason'] = 'Fiscal stamp discount'
            return result

        # MercadoLibre refund
        if 'MERPAGO' in full_text or 'MERCADOLIBRE' in full_text:
            result['category'] = 'supplies'
            result['category_name'] = 'Supplies (refund)'
            result['confidence'] = 'auto'
            result['reason'] = 'MercadoLibre refund/credit'
            return result

        # Unknown income
        result['category'] = 'income_other'
        result['category_name'] = 'Income - Other'
        result['confidence'] = 'unknown'
        result['reason'] = f'Unknown credit: {desc_upper[:60]}'
        return result

    def _tier1_exact(self, result, desc_upper, amount, spei, concept, payee, full_text='', ref_upper=''):
        """Tier 1: High-confidence exact pattern matches."""

        # --- SPEI-based classification ---
        if spei:
            # DANIEL BUSINESS
            if 'DANIEL' in payee and 'BUSINESS' in payee:
                return self._classify_daniel(result, concept, amount)

            # SERGIO GRACIA
            if 'SERGIO' in payee and 'GRACIA' in payee:
                return self._classify_sergio(result, concept, amount)

            # MAYELA GOMEZ
            if 'MAYELA' in payee or 'ETLIA MAYELA' in payee:
                return self._classify_mayela(result, concept, amount)

            # BIONAY
            if 'BIONAY' in payee:
                result['category'] = 'cleaning_services'
                result['category_name'] = 'Cleaning Services'
                result['vendor_key'] = 'bionay'
                result['vendor_name'] = 'Bionay'
                result['confidence'] = 'auto'
                result['reason'] = 'Bionay cleaning supplies'
                return result

            # ABRAHAM VACA / INTERNET
            if 'ABRAHAM' in payee or 'ABRAHM' in payee or 'VACA' in payee:
                result['category'] = 'internet'
                result['category_name'] = 'Internet'
                result['vendor_key'] = 'abraham_vaca'
                result['vendor_name'] = 'Abraham Vaca'
                result['confidence'] = 'auto'
                result['reason'] = 'Abraham Vaca internet service'
                return result

            # ALBERCAS DE VALLARTA
            if 'ALBERCAS' in payee:
                result['category'] = 'maintenance'
                result['category_name'] = 'Maintenance'
                result['vendor_key'] = 'albercas'
                result['vendor_name'] = 'Albercas de Vallarta'
                result['confidence'] = 'auto'
                result['reason'] = 'Pool maintenance'
                return result

            # IGNACIO RUBIO / AC
            if 'IGNACIO' in payee or 'RUBIO' in payee:
                result['category'] = 'maintenance'
                result['category_name'] = 'Maintenance'
                result['vendor_key'] = 'ignacio_rubio'
                result['vendor_name'] = 'Ignacio Rubio'
                result['confidence'] = 'auto'
                result['reason'] = 'AC / maintenance (Ignacio Rubio)'
                return result

            # SUSY
            if 'SUSY' in payee:
                return self._classify_susy(result, concept, amount)

            # LAVANDERIA
            if 'LAVANDERIA' in payee:
                result['category'] = 'laundry'
                result['category_name'] = 'Laundry'
                result['vendor_key'] = 'lavanderia'
                result['vendor_name'] = 'Lavanderia de la Costa'
                result['confidence'] = 'auto'
                result['reason'] = 'Laundry service'
                return result

            # OTIS
            if 'OTIS' in payee:
                result['category'] = 'elevator'
                result['category_name'] = 'Elevator Expense'
                result['vendor_key'] = 'otis'
                result['vendor_name'] = 'Otis Elevator Company'
                result['confidence'] = 'auto'
                result['reason'] = 'Elevator maintenance'
                return result

            # MURAL = neighborhood donation (confirmed by Jason 2026-08-06)
            if 'MURAL' in payee:
                result['category'] = 'donations'
                result['category_name'] = 'Donations & Fundraising'
                result['vendor_key'] = 'mural'
                result['vendor_name'] = 'Mural'
                result['confidence'] = 'auto'
                result['reason'] = 'Mural neighborhood donation'
                result['note'] = 'Neighborhood mural donation'
                return result

            # PINTUCITY / paint supplies
            if 'PINTUCITY' in payee or 'PINTURAS' in payee or 'PINTUR' in payee:
                result['category'] = 'maintenance'
                result['category_name'] = 'Maintenance'
                result['vendor_key'] = 'pintucity'
                result['vendor_name'] = 'Pintucity'
                result['confidence'] = 'auto'
                result['reason'] = 'Paint supplies (maintenance materials)'
                return result

            # CARPINTERO
            if 'CARPINTERO' in payee or 'CARPINTER' in payee:
                result['category'] = 'carpentry'
                result['category_name'] = 'Carpentry'
                result['vendor_key'] = 'carpintero'
                result['vendor_name'] = 'CARPINTERO'
                result['confidence'] = 'auto'
                result['reason'] = 'Carpentry work'
                return result

            # VIVEROS
            if 'VIVEROS' in payee or 'VILLANUEVA' in payee:
                result['category'] = 'landscaping'
                result['category_name'] = 'Landscaping'
                result['vendor_key'] = 'viveros'
                result['vendor_name'] = 'Viveros Villanueva'
                result['confidence'] = 'auto'
                result['reason'] = 'Landscaping / nursery'
                return result

            # BLUE POOLS
            if 'BLUE POOL' in payee:
                result['category'] = 'maintenance'
                result['category_name'] = 'Maintenance'
                result['vendor_key'] = 'blue_pools'
                result['vendor_name'] = 'Blue Pools'
                result['confidence'] = 'auto'
                result['reason'] = 'Pool maintenance (Blue Pools)'
                return result

        # --- Non-SPEI auto-debits ---

        # TELMEX (various patterns)
        if 'TELMEX' in desc_upper or 'TELMEX' in ref_upper:
            result['category'] = 'internet'
            result['category_name'] = 'Internet'
            result['vendor_key'] = 'telmex'
            result['vendor_name'] = 'Telmex'
            result['confidence'] = 'auto'
            result['reason'] = 'Telmex internet/phone'
            return result

        # CFE / CFEMATICO (electricity)
        if 'CFE' in desc_upper or 'CFEMATICO' in desc_upper:
            result['category'] = 'electricity'
            result['category_name'] = 'Electricity'
            result['vendor_key'] = 'cfe'
            result['vendor_name'] = 'CFE'
            result['confidence'] = 'auto'
            result['reason'] = 'CFE electricity bill'
            return result

        # OROMAPAS (water — merged with Water)
        if 'OROMAPAS' in desc_upper:
            result['category'] = 'water'
            result['category_name'] = 'Water'
            result['vendor_key'] = 'oromapas'
            result['vendor_name'] = 'Oromapas'
            result['confidence'] = 'auto'
            result['reason'] = 'Water utility (OROMAPAS)'
            return result

        # ISR (tax withholding on interest)
        if desc_upper.strip() == 'ISR':
            result['category'] = 'tax'
            result['category_name'] = 'Tax'
            result['confidence'] = 'auto'
            result['reason'] = 'ISR tax withholding on interest'
            return result

        # Fiscal stamp
        if 'TIMBRADO FISCAL' in desc_upper:
            result['category'] = 'bank_fee'
            result['category_name'] = 'Bank Fee'
            result['vendor_key'] = 'kapital'
            result['vendor_name'] = 'Kapital Mexico'
            result['confidence'] = 'auto'
            result['reason'] = 'Fiscal stamp commission'
            return result

        # MercadoLibre purchase
        if 'MERPAGO' in full_text or 'MERCADOLIBRE' in full_text:
            result['category'] = 'supplies'
            result['category_name'] = 'Supplies'
            result['confidence'] = 'guess'
            result['reason'] = 'MercadoLibre purchase — check receipt channels for context'
            result['needs_channel_check'] = ['C0AEPQ5BCP9', 'C0BNCFZQ70B']
            return result

        # Kapital bank fee
        if 'KAPITAL' in desc_upper and ('COMISI' in desc_upper or 'MANEJO' in desc_upper):
            result['category'] = 'bank_fee'
            result['category_name'] = 'Bank Fee'
            result['vendor_key'] = 'kapital'
            result['vendor_name'] = 'Kapital Mexico'
            result['confidence'] = 'auto'
            result['reason'] = 'Kapital bank fee'
            return result

        return None

    def _tier2_keyword(self, result, desc_upper, amount, spei, concept, payee):
        """Tier 2: Pattern + keyword disambiguation."""

        # SPEI to unknown payees — try keyword matching on concept
        if spei and concept:
            # Cleaning keywords
            if any(kw in concept for kw in ['CLEANING', 'LIMPIEZA', 'CLEAN']):
                result['category'] = 'cleaning_services'
                result['category_name'] = 'Cleaning Services'
                result['confidence'] = 'guess'
                result['reason'] = f'Cleaning keyword in concept: {concept}'
                return result

            # Maintenance keywords
            if any(kw in concept for kw in ['MAINTENANCE', 'MANTENIMIENTO', 'REPAIR', 'FIX']):
                result['category'] = 'maintenance'
                result['category_name'] = 'Maintenance'
                result['confidence'] = 'guess'
                result['reason'] = f'Maintenance keyword in concept: {concept}'
                return result

            # Activity/group keywords
            if any(kw in concept for kw in ['ACTIVIT', 'WEDDING', 'CHURCH', 'EVENT', 'GROUP']):
                result['category'] = 'group_activities'
                result['category_name'] = 'Group Activities'
                result['confidence'] = 'guess'
                result['reason'] = f'Group/activity keyword in concept: {concept}'
                return result

            # Landscaping keywords
            if any(kw in concept for kw in ['GARDEN', 'JARDIN', 'PLANT', 'LANDSCAPE']):
                result['category'] = 'landscaping'
                result['category_name'] = 'Landscaping'
                result['confidence'] = 'guess'
                result['reason'] = f'Landscaping keyword in concept: {concept}'
                return result

            # Transportation keywords
            if any(kw in concept for kw in ['TRANSPORT', 'TAXI', 'UBER', 'AIRPORT']):
                result['category'] = 'transportation'
                result['category_name'] = 'Transportation Services'
                result['confidence'] = 'guess'
                result['reason'] = f'Transportation keyword in concept: {concept}'
                return result

        return None

    def _classify_daniel(self, result, concept, amount):
        """Classify Daniel Business transfers."""
        result['vendor_key'] = 'daniel_business'
        result['vendor_name'] = 'Daniel Business'

        # Monthly salary
        if any(kw in concept for kw in ['MONTLHY SALARY', 'MONTHLY SALARY', 'SALARY DANIEL']):
            result['category'] = 'contract_labor'
            result['category_name'] = 'Contract Labor'
            result['confidence'] = 'auto'
            result['reason'] = f'Daniel monthly salary (${amount:,.0f})'
            # Check if concept specifies which month
            month_names = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
                           'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
                           'JAN', 'FEB', 'MAR', 'APR', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
            specified_month = None
            for m in month_names:
                if m in concept:
                    specified_month = m
                    break
            if specified_month:
                result['note'] = f'Daniel monthly salary for {specified_month}'
            else:
                result['note'] = 'Daniel monthly salary — month not specified in concept'
                result['ask_month_attribution'] = True
                result['needs_channel_check'] = ['C06BGNK0XQS']
            return result

        # Deep cleaning
        if 'DEEP CLEANING' in concept:
            result['category'] = 'cleaning_services'
            result['category_name'] = 'Cleaning Services'
            result['confidence'] = 'auto'
            result['reason'] = f'Daniel deep cleaning: {concept}'
            result['note'] = concept
            return result

        # Check-in / refresh cleaning
        if 'CHECK IN' in concept or 'CLEANING' in concept or 'REFRESH' in concept:
            result['category'] = 'cleaning_services'
            result['category_name'] = 'Cleaning Services'
            result['confidence'] = 'auto'
            result['reason'] = f'Daniel cleaning: {concept}'
            result['note'] = concept
            return result

        # Preventive maintenance
        if 'PREVENTIVE' in concept or 'MAINTENANCE' in concept:
            result['category'] = 'supplies'
            result['category_name'] = 'Supplies'
            result['confidence'] = 'auto'
            result['reason'] = f'Daniel maintenance purchases: {concept}'
            result['note'] = concept
            return result

        # Reimbursement — ping Mayela for context
        if 'REINBURSMENT' in concept or 'REIMBURS' in concept:
            result['category'] = 'supplies'
            result['category_name'] = 'Supplies'
            result['confidence'] = 'guess'
            result['reason'] = f'Daniel reimbursement — ping Mayela in receipt channel: {concept}'
            result['needs_channel_check'] = ['C06BGNK0XQS', 'C0BNGNQ6GLE', 'C0AEPQ5BCP9']
            result['ping_mayela'] = True
            result['note'] = f'Ask Mayela: what was this Daniel reimbursement for? ${amount:,.0f} MXN, concept: {concept}'
            return result

        # Vague/unknown ("PER JASON", etc) — ping Mayela, not Jason
        result['category'] = 'supplies'
        result['category_name'] = 'Supplies'
        result['confidence'] = 'guess'
        result['reason'] = f'Daniel transfer with unclear purpose: {concept} — ping Mayela'
        result['needs_channel_check'] = ['C06BGNK0XQS', 'C0BNGNQ6GLE']
        result['ping_mayela'] = True
        result['note'] = f'Ask Mayela: what is this Daniel transfer for? ${amount:,.0f} MXN, concept: {concept}'
        return result

    def _classify_sergio(self, result, concept, amount):
        """Classify Sergio Gracia transfers."""
        result['vendor_key'] = 'sergio_gracia'
        result['vendor_name'] = 'Sergio Gracia'

        # Weekly salary
        if 'WEEKLY PAYMENT' in concept or 'WEEKLY PAY' in concept:
            result['category'] = 'contract_labor'
            result['category_name'] = 'Contract Labor'
            result['confidence'] = 'auto'
            if amount > 5500:  # Legacy combined $8k (Sergio $5k + Temo $3k)
                result['reason'] = f'Sergio weekly salary (${amount:,.0f} — legacy combined with Temo)'
                result['note'] = f'Sergio+Temo combined weekly payment (legacy). Sergio $5k + Temo $3k.'
            else:
                result['reason'] = f'Sergio weekly salary (${amount:,.0f})'
                result['note'] = 'Sergio weekly salary'
            return result

        # Petty cash reimbursement → default to Maintenance (materials)
        if 'REINBURSMENT PETTY CASH' in concept or 'PETTY CASH' in concept:
            result['category'] = 'maintenance'
            result['category_name'] = 'Maintenance'
            result['confidence'] = 'auto'
            result['reason'] = f'Sergio petty cash reimbursement (${amount:,.0f}) — maintenance materials'
            result['needs_channel_check'] = ['C0BN3A8PFPH', 'C086546JLLU']
            result['note'] = f'Sergio petty cash ${amount:,.0f} — maintenance materials. If unclear, ping Mayela in receipt channel.'
            return result

        # Temo payment
        if 'TEMO' in concept or 'HELPER' in concept:
            result['category'] = 'contract_labor'
            result['category_name'] = 'Contract Labor'
            result['confidence'] = 'auto'
            result['reason'] = f'Temo (Sergio helper) payment (${amount:,.0f})'
            result['note'] = 'Temo weekly salary (via Sergio)'
            return result

        # Unknown Sergio transfer
        result['category'] = 'maintenance'
        result['category_name'] = 'Maintenance'
        result['confidence'] = 'guess'
        result['reason'] = f'Sergio transfer — assumed maintenance: {concept}'
        result['needs_channel_check'] = ['C0BN3A8PFPH', 'C0BNF913ERK']
        return result

    def _classify_mayela(self, result, concept, amount):
        """Classify Mayela Gomez transfers."""
        result['vendor_key'] = 'mayela_gomez'
        result['vendor_name'] = 'Mayela Gomez'

        # Monthly salary ($30k)
        if amount >= 28000 and amount <= 32000:
            result['category'] = 'contract_labor'
            result['category_name'] = 'Contract Labor'
            result['confidence'] = 'auto'
            result['reason'] = f'Mayela monthly salary (${amount:,.0f})'
            # Check if concept specifies which month
            month_names = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
                           'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
                           'JAN', 'FEB', 'MAR', 'APR', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
            specified_month = None
            for m in month_names:
                if m in concept:
                    specified_month = m
                    break
            if specified_month:
                result['note'] = f'Mayela monthly salary for {specified_month}'
            else:
                result['note'] = f'Mayela monthly salary — month not specified (concept: {concept})'
                result['ask_month_attribution'] = True
                result['needs_channel_check'] = ['C06C5G0PPUY']
            return result

        # Other Mayela transfers — likely expenses
        result['category'] = 'supplies'
        result['category_name'] = 'Supplies'
        result['confidence'] = 'guess'
        result['reason'] = f'Mayela non-salary transfer (${amount:,.0f}) — check receipts: {concept}'
        result['needs_channel_check'] = ['C06C5G0PPUY', 'C086546JLLU']
        return result

    def _classify_susy(self, result, concept, amount):
        """Classify Susy transfers."""
        result['vendor_key'] = 'susy'
        result['vendor_name'] = 'Susy'

        # Church / wedding = Group Activities
        if any(kw in concept for kw in ['CHURCH', 'WEDDING', 'IGLESIA', 'BODA']):
            result['category'] = 'group_activities'
            result['category_name'] = 'Group Activities'
            result['confidence'] = 'auto'
            result['reason'] = f'Susy wedding/church activity: {concept}'
            result['note'] = concept
            return result

        # Cleaning / common areas
        if any(kw in concept for kw in ['CLEANING', 'COMMON AREAS', 'LIMPIEZA']):
            result['category'] = 'cleaning_services'
            result['category_name'] = 'Cleaning Services'
            result['confidence'] = 'auto'
            result['reason'] = f'Susy cleaning: {concept}'
            result['note'] = concept
            return result

        # Default Susy = cleaning
        result['category'] = 'cleaning_services'
        result['category_name'] = 'Cleaning Services'
        result['confidence'] = 'guess'
        result['reason'] = f'Susy transfer — assumed cleaning: {concept}'
        result['needs_channel_check'] = ['C0BPD2F7Q3A']
        return result

    def _suggest_channels(self, payee: str, concept: str) -> List[str]:
        """Suggest receipt channels to check for unknown transactions."""
        channels = ['C0AEPQ5BCP9']  # Always include general receipts

        if 'DANIEL' in payee:
            channels.extend(['C06BGNK0XQS', 'C0BNGNQ6GLE'])
        elif 'SERGIO' in payee:
            channels.extend(['C0BN3A8PFPH', 'C0BNF913ERK', 'C086546JLLU'])
        elif 'MAYELA' in payee:
            channels.extend(['C06C5G0PPUY', 'C086546JLLU'])
        else:
            channels.extend(['C0BNCFZQ70B', 'C0BNJUBMM18', 'C0BNNMBJJ20'])

        return channels


def format_classification_report(results: Dict[str, List[Dict]], month_label: str = '') -> str:
    """Format classification results as a readable report."""
    auto = results['auto']
    guess = results['guess']
    unknown = results['unknown']

    lines = []
    lines.append(f"📊 *Kapital {month_label} — {len(auto) + len(guess) + len(unknown)} transactions*\n")

    # Summary by category
    lines.append(f"✅ *Auto-classified ({len(auto)}):*")
    category_totals = {}
    for t in auto:
        cat = t.get('category_name', 'Unknown')
        amt = t.get('amount', 0)
        direction = t.get('direction', 'debit')
        if cat not in category_totals:
            category_totals[cat] = {'count': 0, 'total': 0.0}
        category_totals[cat]['count'] += 1
        category_totals[cat]['total'] += amt

    for cat, data in sorted(category_totals.items(), key=lambda x: -x[1]['total']):
        lines.append(f"  • {cat}: ${data['total']:,.2f} MXN ({data['count']} txns)")

    if guess:
        lines.append(f"\n⚠️ *Best guess — confirm ({len(guess)}):*")
        for i, t in enumerate(guess, 1):
            date_str = t['date'].isoformat() if t.get('date') else '?'
            amt = t.get('amount', 0)
            cat = t.get('category_name', '?')
            reason = t.get('reason', '')
            payee = t.get('vendor_name', '')
            if not payee and t.get('spei'):
                payee = t['spei'].get('payee', '')
            lines.append(f"  {i}. {date_str} — {payee} ${amt:,.2f} → {cat}")
            lines.append(f"     _{reason}_")

    if unknown:
        lines.append(f"\n❓ *Needs human review ({len(unknown)}):*")
        for i, t in enumerate(unknown, 1):
            date_str = t['date'].isoformat() if t.get('date') else '?'
            amt = t.get('amount', 0)
            reason = t.get('reason', '')
            payee = ''
            if t.get('spei'):
                payee = t['spei'].get('payee', '')
            desc_short = t.get('description', '')[:60]
            lines.append(f"  {i}. {date_str} — {payee or desc_short} ${amt:,.2f}")
            lines.append(f"     _{reason}_")
            if t.get('note'):
                lines.append(f"     💬 {t['note']}")

    return '\n'.join(lines)


if __name__ == '__main__':
    import sys
    from kapital_parser import parse_kapital_csv

    if len(sys.argv) < 2:
        print("Usage: python classifier.py <csv_file>")
        sys.exit(1)

    meta, txns = parse_kapital_csv(sys.argv[1])
    classifier = KapitalClassifier()
    results = classifier.classify_all(txns)

    report = format_classification_report(results, meta.get('statement_type', ''))
    print(report)
