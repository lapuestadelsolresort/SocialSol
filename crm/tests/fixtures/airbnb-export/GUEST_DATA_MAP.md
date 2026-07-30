# Test fixture — Guest Data Map (matches the small fixture set)

| What We Have | Count |
|---|---|
| Total unique guests | 6 |
| Guests with first names | 6 |
| Guests with email addresses | 1 |
| Guests with phone numbers | 3 |
| Guests with both email + phone | 1 |
| Guests who completed a stay | 3 |
| Guests who cancelled | 1 |
| Guests who only inquired (never booked) | 1 |
| Guests from message threads only | 1 |
| Guests who left a review | 1 |
| Repeat guests (2+ bookings) | 0 |

This fixture covers 4 threads, 9 messages. guest_contacts.json has 3 raw rows
across 2 distinct accountIds (one duplicate: accountId=66666 has Alex's phone
and Jordan's phone shared in the same thread). All fixture identities and
contact details are synthetic.
