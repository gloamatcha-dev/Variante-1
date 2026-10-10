# Refund tax allocation (081)

`financial_events` remains the sole monetary ledger. Each positive settled refund
delta is recorded even when its tax allocation is unsupported. In that case
`net_cents` and `tax_cents` remain NULL and `tax_status` is
`tax_allocation_required`. Known zero tax remains 0.

`refund_tax_allocation_evidence` contains immutable component proof for an
allocated event, not another total/payment ledger. Only the versioned Finance
writers may insert proof. Browser roles and direct service-role mutation are
denied. Original line/order/plan references and integer component cents are
retained for subsequent cumulative allocations.

## Inputs and evidence

The two public v2 writers accept a subject ID, cumulative settled gross total,
external reference, optional operation ID, scope and optional withdrawal ID.
They do not accept net, tax, a rate or client payment totals.

- `manual` (default): record gross and leave tax unknown.
- `full_remaining`: an explicit trusted server assertion that every remaining
  original component, including shipping, is refunded. The exact cumulative
  total and original snapshots must reconcile. A stored nonzero Wertersatz
  prevents this assertion from bypassing review.
- `withdrawal`: use the locked approved/executed case, matching subject,
  operation and exact gross delta. Whole scope refunds remaining original
  components. Partial order scope requires the original item, quantity and
  explicit whole-shipping/no-shipping decision. Nonzero Wertersatz is unknown.

Unknown prior tax allocations stop automatic allocation. No historical event is
updated. Even a prior non-NULL event needs component proof before it is consumed
as an authoritative allocation.

The Stripe webhook passes withdrawal scope only for an exact successful refund
object with validated case/operation metadata. Aggregate charge notifications
and ordinary amount-only Admin refunds retain unknown tax. An aggregate event
recorded first can therefore keep tax unknown on replay; this is intentional
fail-closed behavior, not permission to repair history during normal processing.

## Quantity rule: cumulative_quantity_v1

Use frozen effective line gross G (catalog gross minus frozen discount), net N,
tax T and original quantity Q. Let previous allocated quantity/cents be q/g/n/t.
For a new quantity r:

- At q+r=Q, take G-g, N-n and T-t exactly.
- Otherwise gross target is ceil(G*(q+r)/Q), with integer division only.
- Tax target is floor(T*(q+r)/Q).
- New gross is target gross minus g.
- New tax is bounded between max(0, new gross-(N-n)) and
  min(new gross, T-t), using the tax target minus t inside those bounds.
- New net is new gross minus new tax.

Every quantity and gross/net/tax component is checked against the original
bounds. No tax percentage, blended rate or floating point is used. The final
quantity absorbs all residual cents. Example fixture G=100, N=93, T=7, Q=3
allocates (gross/net/tax): (34/32/2), (33/31/2), (33/30/3).

If the approved payout differs from the sum of these exact component deltas,
tax stays unknown; existing withdrawal gross/refund approval logic is not
repriced or changed by 081.

## Annual and shipping

Annual full refunds use only the validated original
`annual_plans.tax_snapshot.totals`. Delivery snapshots and current tax settings
are never used. Annual partial refunds remain unknown without exact scope.

Order shipping uses the original shipping gross/net difference, reconciled
with the original order totals. An explicit refund-outbound-shipping decision
takes its exact remaining amounts; retention adds no shipping component.
Arbitrary partial shipping amounts are unsupported.

## Retry, security and rollout

The subject advisory locks are identical to legacy 072, with authoritative row
locks and a stable operation lock added. Same-operation replay returns the
existing event; a different operation for the same cumulative total has no
delta. Provider payout, provider idempotency, email, Affiliate and Inventory
behavior are not changed.

Legacy refund RPC bodies/ACLs and migrations 001-080 are untouched. Install 081
manually only after review/preflight, then deploy application callers. No
backfill is part of installation or application processing. Future historical
repair requires exact original snapshots, scope and all prior allocation proof;
gross-only legacy, unclear shipping, Wertersatz and partial Annual cases are not
automatically eligible.
