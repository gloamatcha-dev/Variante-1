import { validateQuoteItems, buildAuthoritativeQuote } from "../../../../lib/checkoutQuote";

type ErrorResponse = {
  error: string;
};

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Ungültige Anfrage." } as ErrorResponse,
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return Response.json(
      { error: "Ungültige Artikel oder Mengen." } as ErrorResponse,
      { status: 400 }
    );
  }

  const { items } = body as { items?: unknown };
  const validatedItems = validateQuoteItems(items);
  if (!validatedItems) {
    return Response.json(
      { error: "Ungültige Artikel oder Mengen." } as ErrorResponse,
      { status: 400 }
    );
  }

  const result = await buildAuthoritativeQuote(validatedItems);
  if (!result.ok) {
    return Response.json(
      { error: result.error } as ErrorResponse,
      { status: result.status }
    );
  }

  return Response.json(result.quote, { status: 200 });
}
