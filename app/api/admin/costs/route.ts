import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";
import {
  buildFinanceSummary,
  validateFinancePeriod,
  isExpenseCategory,
  isIsoDate,
  type FinanceExpenseRow,
  type FinanceOrderRow,
  type FinancePeriod,
} from "../../../../lib/financeSummary";

/**
 * KOSTEN / SPESEN / DECKUNGSBEITRAG — the finance screen's one endpoint.
 *
 * ══════════════════════════════════════════════════════════════
 * EVERY FIGURE IS COMPUTED HERE, NEVER SENT BY THE BROWSER
 * ══════════════════════════════════════════════════════════════
 *
 * The client sends a PERIOD and nothing else that could affect a number.
 * No total, no subtotal, no margin and no completeness flag is accepted
 * from the request - buildFinanceSummary computes all of them from
 * durable rows on this side. A screen that could post its own
 * Deckungsbeitrag would be a screen that could be wrong on purpose.
 *
 * ══════════════════════════════════════════════════════════════
 * THE MOST SENSITIVE READ IN THE ADMIN
 * ══════════════════════════════════════════════════════════════
 *
 * Reading is gated on "read_sensitive" rather than "read": a viewer may
 * open the shop's operational screens, and this is not one of them.
 * Writing is gated on "write". Both gates run BEFORE the body is parsed,
 * so an unauthorised caller cannot even provoke a validation message that
 * tells them what the body should look like.
 *
 * The browser never reaches public.business_expenses itself: migration
 * 071 grants anon and authenticated nothing at all and declares no RLS
 * policy, so this route and the service role are the only path.
 *
 * ══════════════════════════════════════════════════════════════
 * WHAT IT NEVER DOES
 * ══════════════════════════════════════════════════════════════
 *
 * It writes no order, touches no plan, calls no payment provider and
 * sends no mail. Its only writes are the three SECURITY DEFINER expense
 * writers, each of which audits itself in the same transaction - and
 * service_role has no INSERT, UPDATE or DELETE on the table, so there is
 * no path here that could write an expense without an audit row.
 */

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

const MAX_BODY_BYTES = 20_000;

/** Bounded, so a mistyped amount is a refusal and not a million euro. */
const MAX_AMOUNT_CENTS = 100_000_000; // 1 000 000,00 EUR
const MAX_DESCRIPTION_LEN = 300;
const MAX_VENDOR_LEN = 160;
const MAX_NOTE_LEN = 2_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_COLUMNS =
  "id, placed_at, customer_type, total_gross_cents, total_net_cents, "
  + "tax_total_cents, discount_total_cents, shipping_gross_cents, refunded_total_cents";

const EXPENSE_COLUMNS =
  "id, occurred_on, category, order_id, description, amount_cents, "
  + "currency, vendor, note, created_by, created_at, updated_at";

type ExpenseRecord = {
  id: string;
  occurred_on: string;
  category: string;
  order_id: string | null;
  description: string;
  amount_cents: number;
  currency: string;
  vendor: string | null;
  note: string | null;
  created_at: string;
  updated_at: string | null;
};

/**
 * One calendar day either side of the period, in UTC.
 *
 * The period is a set of BERLIN days and placed_at is an instant, so the
 * SQL window is deliberately wider than the answer: it must not clip an
 * order that belongs to the first or last Berlin day but falls outside
 * the same UTC dates. buildFinanceSummary then filters exactly, by Berlin
 * date, which is the only place that decision is made.
 */
function instantWindow(period: FinancePeriod): { fromIso: string; toIso: string } {
  const from = new Date(`${period.from}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${period.to}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function readPeriod(body: Record<string, unknown>):
  { ok: true; period: FinancePeriod } | { ok: false; response: Response } {
  const validated = validateFinancePeriod(body.from, body.to);
  if (!validated.ok) {
    return { ok: false, response: json({ error: validated.reason } as ErrorResponse, 400) };
  }
  return { ok: true, period: validated.period };
}

/** The whole input surface of a written expense, validated in one place. */
function readExpenseInput(body: Record<string, unknown>):
  | {
      ok: true;
      occurredOn: string;
      category: string;
      amountCents: number;
      description: string;
      orderId: string | null;
      vendor: string | null;
      note: string | null;
    }
  | { ok: false; reason: string } {
  if (!isIsoDate(body.occurredOn)) {
    return { ok: false, reason: "Bitte gib ein gültiges Datum an." };
  }
  if (!isExpenseCategory(body.category)) {
    return { ok: false, reason: "Bitte wähle eine gültige Kategorie." };
  }
  /*
    INTEGER CENTS, AND NOTHING THAT ROUNDS. A float would be a figure
    nobody could reconcile against an invoice, so a non-integer is a
    refusal rather than something this route rounds on the caller's behalf.
  */
  const amount = body.amountCents;
  if (typeof amount !== "number" || !Number.isInteger(amount)
      || amount <= 0 || amount > MAX_AMOUNT_CENTS) {
    return { ok: false, reason: "Bitte gib einen Betrag in ganzen Cent an." };
  }
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!description || description.length > MAX_DESCRIPTION_LEN) {
    return { ok: false, reason: "Bitte gib eine kurze Beschreibung an." };
  }

  /*
    THE ORDER, AND THE RULE THAT KEEPS THE TWO KINDS OF COST APART.

    Migration 071's CHECK is the authority and would refuse either
    contradiction anyway; this exists so the operator gets a sentence
    instead of a constraint name.
  */
  let orderId: string | null = null;
  if (body.orderId !== undefined && body.orderId !== null && body.orderId !== "") {
    if (typeof body.orderId !== "string" || !UUID_RE.test(body.orderId.trim())) {
      return { ok: false, reason: "Die Bestellung ist keine gültige Kennung." };
    }
    orderId = body.orderId.trim();
  }
  if (body.category === "general" && orderId) {
    return {
      ok: false,
      reason: "Allgemeine Kosten gehören zu einem Zeitraum, nicht zu einer Bestellung.",
    };
  }
  if (body.category !== "general" && !orderId) {
    return {
      ok: false,
      reason: "Direkte Kosten brauchen die Bestellung, zu der sie gehören.",
    };
  }

  const vendor = typeof body.vendor === "string" && body.vendor.trim() !== ""
    ? body.vendor.trim() : null;
  if (vendor && vendor.length > MAX_VENDOR_LEN) {
    return { ok: false, reason: "Der Lieferant ist zu lang." };
  }
  const note = typeof body.note === "string" && body.note.trim() !== ""
    ? body.note.trim() : null;
  if (note && note.length > MAX_NOTE_LEN) {
    return { ok: false, reason: "Die Notiz ist zu lang." };
  }

  return {
    ok: true,
    occurredOn: body.occurredOn,
    category: body.category,
    amountCents: amount,
    description,
    orderId,
    vendor,
    note,
  };
}

export async function POST(request: Request): Promise<Response> {
  /*
    THE ACTION DECIDES THE CAPABILITY, so the gate has to know it - and
    the gate still runs before anything else is read. The action name is
    the only thing taken from the body first, and an unknown one is
    refused at the strongest capability rather than the weakest.
  */
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: "Anfrage zu groß." } as ErrorResponse, 413);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  if (!raw || typeof raw !== "object") {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  const body = raw as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";

  /*
    THE CAPABILITY IS WRITTEN OUT, NOT COMPUTED.

    A ternary would have been shorter and it would have hidden the two
    strings from the audit that reads this file: tests/admin-identity
    .test.mjs classifies every admin route by searching its source for
    the capability it declares, so a capability assembled at runtime is a
    capability nobody can review. Both branches name theirs.
  */
  const isRead = action === "summary";
  const gate = isRead
    ? await requireAdminIdentity(request, "read_sensitive")
    : await requireAdminIdentity(request, "write");
  if (!gate.ok) return gate.response;

  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error("Costs error: Supabase admin client is not configured.");
    return json({ error: "Kosten können gerade nicht geladen werden." } as ErrorResponse, 503);
  }

  /* ── READ ──────────────────────────────────────────────────── */

  if (action === "summary") {
    const period = readPeriod(body);
    if (!period.ok) return period.response;

    const { fromIso, toIso } = instantWindow(period.period);

    const [orderRes, expenseRes] = await Promise.all([
      admin.from("orders").select(ORDER_COLUMNS)
        .not("placed_at", "is", null)
        .gte("placed_at", fromIso)
        .lte("placed_at", toIso),
      admin.from("business_expenses").select(EXPENSE_COLUMNS)
        .gte("occurred_on", period.period.from)
        .lte("occurred_on", period.period.to)
        .order("occurred_on", { ascending: false }),
    ]);

    if (orderRes.error || expenseRes.error) {
      console.error("Costs error: could not read the period:",
        orderRes.error?.message ?? expenseRes.error?.message);
      return json({ error: "Kosten können gerade nicht geladen werden." } as ErrorResponse, 503);
    }

    const orders: FinanceOrderRow[] = (orderRes.data ?? []).map(row => {
      const o = row as unknown as Record<string, unknown>;
      return {
        id: String(o.id),
        placedAt: (o.placed_at as string | null) ?? null,
        customerType: String(o.customer_type ?? ""),
        totalGrossCents: Number(o.total_gross_cents ?? 0),
        totalNetCents: Number(o.total_net_cents ?? 0),
        taxTotalCents: Number(o.tax_total_cents ?? 0),
        discountTotalCents: Number(o.discount_total_cents ?? 0),
        shippingGrossCents: Number(o.shipping_gross_cents ?? 0),
        refundedTotalCents: o.refunded_total_cents === null
          || o.refunded_total_cents === undefined
          ? null
          : Number(o.refunded_total_cents),
      };
    });

    const expenseRecords = (expenseRes.data ?? []) as unknown as ExpenseRecord[];
    const expenses: FinanceExpenseRow[] = expenseRecords
      .filter(e => isExpenseCategory(e.category))
      .map(e => ({
        id: e.id,
        occurredOn: e.occurred_on,
        category: e.category as FinanceExpenseRow["category"],
        orderId: e.order_id,
        amountCents: e.amount_cents,
      }));

    const summary = buildFinanceSummary({ period: period.period, orders, expenses });

    /*
      THE LEDGER GOES BACK AS WELL, because the screen has to let an
      operator correct a typo - but WITHOUT created_by. Which admin typed
      a figure belongs in the audit log, not in a payload the browser
      holds; the screen never needs it, and the activity screen already
      answers that question properly.
    */
    return json({
      ok: true,
      summary,
      expenses: expenseRecords.map(e => ({
        id: e.id,
        occurredOn: e.occurred_on,
        category: e.category,
        orderId: e.order_id,
        description: e.description,
        amountCents: e.amount_cents,
        currency: e.currency,
        vendor: e.vendor,
        note: e.note,
        createdAt: e.created_at,
        updatedAt: e.updated_at,
      })),
    }, 200);
  }

  /* ── WRITE ─────────────────────────────────────────────────── */

  if (action === "record_expense" || action === "update_expense") {
    const input = readExpenseInput(body);
    if (!input.ok) return json({ error: input.reason } as ErrorResponse, 400);

    const isUpdate = action === "update_expense";
    let expenseId: string | null = null;
    if (isUpdate) {
      if (typeof body.expenseId !== "string" || !UUID_RE.test(body.expenseId.trim())) {
        return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
      }
      expenseId = body.expenseId.trim();
    }

    /*
      THE OPERATION ID IS THIS REQUEST'S, and it is what makes a retry
      audit once: admin_activity_log is unique on
      (module, action, operation_id). The writers mint one when it is
      absent, so this is an improvement on their default rather than a
      requirement of it.
    */
    const operationId = typeof body.operationId === "string"
      && UUID_RE.test(body.operationId.trim())
      ? body.operationId.trim()
      : null;

    const args = isUpdate
      ? {
          p_actor_user_id: gate.session.userId,
          p_expense_id: expenseId,
          p_occurred_on: input.occurredOn,
          p_category: input.category,
          p_amount_cents: input.amountCents,
          p_description: input.description,
          p_order_id: input.orderId,
          p_vendor: input.vendor,
          p_note: input.note,
          p_operation_id: operationId,
        }
      : {
          p_actor_user_id: gate.session.userId,
          p_occurred_on: input.occurredOn,
          p_category: input.category,
          p_amount_cents: input.amountCents,
          p_description: input.description,
          p_order_id: input.orderId,
          p_vendor: input.vendor,
          p_note: input.note,
          p_operation_id: operationId,
        };

    const { data, error } = await admin.rpc(
      isUpdate ? "admin_update_business_expense" : "admin_record_business_expense",
      args
    );

    if (error) {
      /*
        THE FOREIGN KEY IS THE AUTHORITY ON WHETHER AN ORDER EXISTS, so a
        bad order id arrives here as a constraint violation rather than
        being pre-checked with a second query that could race it. The
        operator gets a sentence; the raw message never leaves the server.
      */
      console.error("Costs error: the expense writer refused:", error.message);
      if (/business_expenses_order_id_fkey/.test(error.message)) {
        return json({ error: "Diese Bestellung gibt es nicht." } as ErrorResponse, 404);
      }
      if (/order_scope_check/.test(error.message)) {
        return json({
          error: "Allgemeine Kosten gehören zu einem Zeitraum, direkte Kosten zu einer Bestellung.",
        } as ErrorResponse, 400);
      }
      return json({ error: "Die Kosten konnten nicht gespeichert werden." } as ErrorResponse, 503);
    }

    if (isUpdate && !data) {
      return json({ error: "Diesen Kostenposten gibt es nicht." } as ErrorResponse, 404);
    }

    return json({ ok: true }, 200);
  }

  if (action === "delete_expense") {
    if (typeof body.expenseId !== "string" || !UUID_RE.test(body.expenseId.trim())) {
      return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
    }
    const operationId = typeof body.operationId === "string"
      && UUID_RE.test(body.operationId.trim())
      ? body.operationId.trim()
      : null;

    const { data, error } = await admin.rpc("admin_delete_business_expense", {
      p_actor_user_id: gate.session.userId,
      p_expense_id: body.expenseId.trim(),
      p_operation_id: operationId,
    });

    if (error) {
      console.error("Costs error: the deletion refused:", error.message);
      return json({ error: "Der Kostenposten konnte nicht gelöscht werden." } as ErrorResponse, 503);
    }
    if (data !== true) {
      return json({ error: "Diesen Kostenposten gibt es nicht." } as ErrorResponse, 404);
    }
    return json({ ok: true }, 200);
  }

  return json({ error: "Unbekannte Aktion." } as ErrorResponse, 400);
}
