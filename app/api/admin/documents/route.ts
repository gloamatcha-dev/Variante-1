import {readPortalPages} from "../../../../lib/adminPortalRead.ts";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { requireAdminIdentity } from "../../../../lib/adminActionRoute.ts";

type ErrorResponse = { error: string };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}



/**
 * THE DOCUMENT DESK.
 *
 * Foundation for documents and document links (072). No PDF visual
 * redesign — this provides the data contracts for managing documents
 * that the admin UI will render.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireAdminIdentity(request, "read");
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }
  if (!body || typeof body !== "object") {
    return json({ error: "Ungültige Anfrage." } as ErrorResponse, 400);
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return json({ error: "Nicht verfügbar." } as ErrorResponse, 503);
  }

  const b = body as Record<string, unknown>;
  const action = b.action;

  if (action === "list" || action === undefined) {
    try {
    const [documents, links] = await Promise.all([
      readPortalPages(admin,"documents"),
      readPortalPages(admin,"document_links",q=>q,"document_id"),
    ]);

    return json({
      ok: true,
      documents,
      links,
    }, 200);
    } catch { return json({error:"Dokumente konnten nicht geladen werden."},503); }
  }

  // ── WRITES ─────────────────────────────────────────────────
  const writeGate = await requireAdminIdentity(request, "write");
  if (!writeGate.ok) return writeGate.response;
  const actorUserId = writeGate.session.userId;
  const str = (k: string): string => (typeof b[k] === "string" ? (b[k] as string) : "");

  if (action === "create_document") {
    const { data, error } = await admin.from("documents").insert({
      title: str("title"),
      kind: str("kind"),
      storage_path: str("storagePath") || null,
      external_reference: str("externalReference") || null,
      mime_type: str("mimeType") || null,
      byte_size: typeof b.sizeBytes === "number" ? b.sizeBytes : null,
      note: str("note") || null,
      created_by: actorUserId,
    }).select("id").single();

    if (error) {
      console.error("Create document failed:", error.message);
      return json({ error: "Erstellen fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true, documentId: data.id }, 200);
  }

  if (action === "link_document") {
    const { data, error } = await admin.from("document_links").upsert({
      document_id: str("documentId"),
      subject_type: str("entityType"),
      subject_id: str("entityId"),

    },{onConflict:"document_id,subject_type,subject_id"}).select("document_id").single();

    if (error) {
      console.error("Link document failed:", error.message);
      return json({ error: "Verknüpfung fehlgeschlagen." } as ErrorResponse, 503);
    }
    return json({ ok: true, documentId: data.document_id }, 200);
  }

  return json({ error: "Unbekannte Aktion." } as ErrorResponse, 400);
}
