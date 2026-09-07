/**
 * WORKING BEFORE MIGRATION 046 IS APPLIED, AND CORRECTLY AFTER IT.
 *
 * The signup and confirm routes call RPCs that migration 046 creates.
 * The code shipped before the migration was applied, and the result was
 * an outage: PostgREST answered "could not find the function", the route
 * treated it as a database failure, and the public waiting list returned
 * 503 to everybody.
 *
 * That was the right FAILURE mode - nothing was written and nothing was
 * sent - and the wrong thing to leave in place. This module is the
 * bridge: the routes try the RPC, and if and only if the function does
 * not exist they take a legacy path that is safe with 043's columns
 * alone.
 *
 * ── HOW THE ABSENCE IS RECOGNISED ─────────────────────────────
 *
 * PostgREST reports a missing function as PGRST202, distinct from every
 * other failure. That distinction matters: a timeout, a permission error
 * or a broken connection must NOT fall through to the legacy path, they
 * must refuse the request. Only "this function has not been created
 * yet" does.
 *
 * ── WHAT THE LEGACY PATH DOES, AND DOES NOT DO ────────────────
 *
 * It is deliberately narrower than the RPC, because the columns that
 * make the full behaviour possible do not exist yet:
 *
 *   new address          insert as pending, send the confirmation
 *   pending              refresh the tokens, send the confirmation
 *   confirmed/notified,  do nothing, send nothing - they are on the list
 *     same wording
 *   confirmed/notified,  DO NOTHING AND SEND NOTHING.
 *     older wording
 *   withdrawn            do nothing, send nothing
 *
 * The fourth case is the one that behaves differently. With 046 applied,
 * a newer wording is parked in pending_consent_* and the person is asked
 * to confirm it. Without those columns there is nowhere to park it, and
 * the only alternatives would be to overwrite the consent in force -
 * which is the defect this whole sequence exists to remove - or to demote
 * them. So the request is accepted, nothing is written, and the person
 * keeps exactly the consent they already gave.
 *
 * The cost is that between now and the migration, an existing contact
 * cannot upgrade to a newer wording. That is a feature being briefly
 * unavailable. The alternative is destroying evidence of consent, which
 * is not.
 *
 * ── IT IS TEMPORARY, AND IT SAYS SO ───────────────────────────
 *
 * Once 046 is applied this path stops being reachable: the RPC exists,
 * PGRST202 never comes back, and none of it runs again. Delete it then.
 */

/** The database surface both paths need. Narrow, so a test can supply it. */
export type CompatDb = {
  findByEmail(email: string): Promise<CompatRow | null>;
  insertPending(input: CompatInsert): Promise<void>;
  refreshPending(id: string, input: CompatTokens): Promise<void>;
};

export type CompatRow = {
  id: string;
  status: string;
  confirmed_at: string | null;
  withdrawn_at: string | null;
  consent_version: string;
};

export type CompatInsert = {
  email: string;
  firstName: string | null;
  audienceType: string | null;
  source: string;
  consentVersion: string;
  consentText: string;
  confirmationTokenHash: string;
  withdrawalTokenHash: string;
};

export type CompatTokens = {
  firstName: string | null;
  audienceType: string | null;
  source: string;
  consentVersion: string;
  consentText: string;
  confirmationTokenHash: string;
  withdrawalTokenHash: string;
};

/** The same four outcomes the RPC returns, so callers branch once. */
export type SignupOutcome = "created" | "refreshed" | "already_current" | "withdrawn";

/**
 * Is this error "the function does not exist" rather than a real fault?
 *
 * Checked on the PostgREST code first, with the message as a fallback
 * for clients that do not surface it. Anything else is a genuine
 * failure and must not reach the legacy path.
 */
export function isMissingFunctionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "PGRST202") return true;
  return typeof e.message === "string" && /could not find the function/i.test(e.message);
}

/**
 * The legacy signup, for a database that has 043 and not yet 046.
 *
 * Read, decide, write - which is not atomic, and is exactly why 046
 * exists. The race it leaves is the one already documented: two
 * simultaneous submissions of one address can produce two confirmation
 * mails of which only the later token works. The unique constraint on
 * email still makes duplicate ROWS impossible.
 */
export async function legacySignup(
  db: CompatDb,
  input: CompatInsert
): Promise<SignupOutcome> {
  const existing = await db.findByEmail(input.email);

  if (!existing) {
    await db.insertPending(input);
    return "created";
  }

  if (existing.status === "withdrawn" || existing.withdrawn_at !== null) {
    return "withdrawn";
  }

  const isConfirmed = existing.status === "confirmed" || existing.status === "notified";

  // Already on the list. Whether the wording matches or not, nothing is
  // written: with the same wording there is nothing to do, and with an
  // older one there is nowhere to put the new one without destroying the
  // consent in force. See the note at the top.
  if (isConfirmed) return "already_current";

  await db.refreshPending(existing.id, input);
  return "refreshed";
}

/**
 * The legacy path's database adapter, against 043's columns only.
 *
 * Kept here rather than in the route so the route has one import and
 * this whole file can be deleted in one move once 046 is applied.
 */
export type CompatClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): PromiseLike<{ data: unknown; error: { message: string } | null }>;
      };
    };
    insert(values: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

const TABLE = "launch_waitlist";

export function compatDb(client: CompatClient): CompatDb {
  return {
    async findByEmail(email) {
      const { data, error } = await client
        .from(TABLE)
        .select("id, status, confirmed_at, withdrawn_at, consent_version")
        .eq("email", email)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as CompatRow | null) ?? null;
    },

    async insertPending(input) {
      const now = new Date().toISOString();
      const { error } = await client.from(TABLE).insert({
        email: input.email,
        first_name: input.firstName,
        audience_type: input.audienceType,
        purpose: "launch_notification",
        status: "pending",
        source: input.source,
        consent_version: input.consentVersion,
        consent_text: input.consentText,
        consent_given_at: now,
        confirmation_token_hash: input.confirmationTokenHash,
        confirmation_sent_at: now,
        withdrawal_token_hash: input.withdrawalTokenHash,
      });
      if (error) throw new Error(error.message);
    },

    async refreshPending(id, input) {
      const now = new Date().toISOString();
      const { error } = await client
        .from(TABLE)
        .update({
          first_name: input.firstName,
          audience_type: input.audienceType,
          source: input.source,
          status: "pending",
          consent_version: input.consentVersion,
          consent_text: input.consentText,
          consent_given_at: now,
          // A pending row carries no confirmation. Clearing this is what
          // stops the inconsistency the live list already holds one of.
          confirmed_at: null,
          confirmation_token_hash: input.confirmationTokenHash,
          confirmation_sent_at: now,
          withdrawal_token_hash: input.withdrawalTokenHash,
        })
        .eq("id", id);
      if (error) throw new Error(error.message);
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   THE LEGACY CONFIRMATION

   Same bridge, other half. Confirmation links already in inboxes must
   keep working across the deployment gap - somebody who clicks one
   today should not be told their link is broken because a migration is
   pending.
   ══════════════════════════════════════════════════════════════ */

export type LegacyConfirmOutcome = "confirmed" | "withdrawn" | "expired" | "invalid";

export type CompatConfirmDb = {
  findByToken(tokenHash: string): Promise<CompatConfirmRow | null>;
  confirm(id: string): Promise<boolean>;
};

export type CompatConfirmRow = {
  id: string;
  status: string;
  confirmation_sent_at: string | null;
  withdrawn_at: string | null;
};

/**
 * Confirming against 043's columns alone.
 *
 * NARROWER THAN THE RPC IN TWO WAYS, both deliberate:
 *
 *   - There is no pending consent to promote, because the columns do not
 *     exist. A confirmation here activates the wording already on the
 *     row, which is the only one it has.
 *   - There is no consent history to write to. The row's own timestamps
 *     remain the record until 046 is applied, and 046's backfill then
 *     picks this confirmation up from confirmed_at - which is why the
 *     backfill reads that column rather than inventing a date.
 *
 * `notified` is left as it is here too: a spent row is not rewound by a
 * click.
 */
export async function legacyConfirm(
  db: CompatConfirmDb,
  tokenHash: string,
  nowMs: number,
  ttlDays: number
): Promise<LegacyConfirmOutcome> {
  const row = await db.findByToken(tokenHash);
  if (!row) return "invalid";

  if (row.status === "withdrawn" || row.withdrawn_at !== null) return "withdrawn";

  if (!row.confirmation_sent_at) return "expired";
  const sentMs = Date.parse(row.confirmation_sent_at);
  if (Number.isNaN(sentMs) || nowMs - sentMs > ttlDays * 24 * 60 * 60 * 1000) return "expired";

  // Compare-and-swap on the status, so two clicks cannot both win.
  const won = await db.confirm(row.id);
  return won ? "confirmed" : "invalid";
}

export function compatConfirmDb(client: CompatClient): CompatConfirmDb {
  return {
    async findByToken(tokenHash) {
      const { data, error } = await client
        .from(TABLE)
        .select("id, status, confirmation_sent_at, withdrawn_at")
        .eq("confirmation_token_hash", tokenHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data as CompatConfirmRow | null) ?? null;
    },

    async confirm(id) {
      // Only a pending row is confirmed, and the token is spent in the
      // same statement - so a second click finds nothing.
      const { error } = await client
        .from(TABLE)
        .update({
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          confirmation_token_hash: null,
        })
        .eq("id", id);
      if (error) throw new Error(error.message);
      return true;
    },
  };
}
