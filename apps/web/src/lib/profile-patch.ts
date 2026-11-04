/** Validate untrusted JSON before the profile route reads or writes user files.
 * @param {unknown} value
 * @returns {string | null} An actionable error, or null for a valid partial patch.
 */
export function profilePatchError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "profile update must be an object";
  }
  const patch = value as Record<string, unknown>;
  for (const field of ["name", "email", "location", "currency", "remote"]) {
    if (field in patch && typeof patch[field] !== "string") {
      return `${field} must be a string`;
    }
  }
  if ("roles" in patch && (!Array.isArray(patch.roles) || patch.roles.some((role: unknown) => typeof role !== "string"))) {
    return "roles must be an array of strings";
  }
  // The action can send a lone bound. The writer ignores it while saving
  // other fields, so do not require a pair here.
  for (const field of ["compMin", "compMax"]) {
    const bound = patch[field];
    if (field in patch && (typeof bound !== "number" || !Number.isFinite(bound) || bound <= 0)) {
      return `${field} must be a positive finite number`;
    }
  }
  if (typeof patch.compMin === "number" && typeof patch.compMax === "number" && patch.compMin > patch.compMax) {
    return "compMin must not exceed compMax";
  }
  return null;
}
