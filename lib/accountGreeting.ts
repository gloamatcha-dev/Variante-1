/**
 * Whose name the account dashboard may greet (Task 29A).
 *
 * Lives here, next to the other presentation helpers, because it is the
 * one piece of the redesign that must not be got wrong: the profile's
 * empty-value placeholder is "-", and the brand is not a person, so
 * "Hallo, -." and "Hallo, GLOA." are both a made-up name shown to a real
 * customer. Returning null lets the dashboard fall back to a neutral
 * greeting instead.
 *
 * Pure and leaf: no imports, no DB, no clock.
 */
export function resolveGreetingName(value: string | null | undefined): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return null;
  // The placeholder the profile UI writes for an unset field, in both the
  // hyphen and the em-dash form the codebase uses.
  if (name === "-" || name === "–" || name === "—") return null;
  // A brand value that reached the name field is not a customer's name.
  if (name.toLowerCase() === "gloa") return null;
  return name;
}
