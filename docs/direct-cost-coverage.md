# Direct cost completeness (082)

Positive amounts remain in `business_expenses`. Evidence tables do not hold money.
Required physical classes: `matcha_cogs`, `packaging`, `shipping`. `other_direct`
is optional; `payment_fee` belongs exclusively to the independent 079 evidence.

Order subjects cover ordinary and 28-day subscription orders and physical Annual
delivery orders. A B2B delivery is always the canonical subject, including when
it has an Order. No fake Order is created. Subject lists use Berlin dispatch
date, plus subjects with actually incurred expenses in the selected period.
Prepayment alone creates neither future costs nor coverage. Unknown dispatch
dates block trusted results conservatively.

Explicit reviewed states are captured, confirmed zero, and not applicable.
Missing evidence is open. Reasons and actor identities are audited. New or
corrected expenses invalidate affected base-class evidence. General expense
create/update/delete invalidates both old/new affected calendar months.
Statement triggers acquire one shared transaction lock before expense row
locks. Coverage authorities use the same lock. Protected legacy functions are
not replaced. B2B Order-link changes reopen affected coverage.

General confirmations refer to whole calendar months. Every month intersecting
a query must be confirmed; confirmation of the whole month suffices for a
submonth query. Current month confirmation is allowed and reopened on changes.

Gross-based internal contribution margin = stored income gross minus stored
refund gross minus direct expense gross (excluding manual payment_fee) minus
authoritatively correlated provider fee gross. It remains unknown if any direct
class/provider evidence is missing, fee events do not reconcile, or any manual
payment_fee exists. Manual fees are never heuristically reconciled or deleted.
Result additionally subtracts stored general expense gross and requires every
intersecting general month confirmation. Tax completeness is independent.
These are internal metrics, not statutory accounts or taxable profit.

Expense corrections and cancellations are explicit Admin work. A customer
refund never reverses costs. Supplier credits require a separately supported
model and are not synthesized as negative expenses. No Inventory movement,
supplier-price valuation, label purchase, or automatic historical backfill.
Document metadata may be linked using existing documents/document_links;
upload/download is outside this feature. CSV net is stored gross minus stored
VAT only when VAT is known; unknown VAT leaves net blank.
