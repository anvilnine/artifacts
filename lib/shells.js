// Filling a shell template's {{PLACEHOLDER}} slots.
//
// One pass, values looked up per slot. Chaining `.replace('{{A}}', a).replace('{{B}}', b)` is
// what this exists to stop: `a` becomes part of the text the second replace searches, so a value
// carrying the literal string `{{B}}` steals that substitution. With the link-preview tags that
// was reachable from data an author controls: a description of `{{CONTENT}}` put the whole
// rendered markdown body, unescaped, inside a quoted meta attribute, and left the real content
// slot in the page as literal text.
//
// A value is inserted verbatim. `$&`, `$1` and friends carry no meaning here, because the
// replacement is a function. Escaping stays the caller's job, as it was before.
//
// A slot with no matching value is left as it stands, which is what a chain of `.replace()` calls
// did for a missing placeholder.
export function fillShell(shell, values) {
  return shell.replace(/\{\{([A-Z_]+)\}\}/g, (slot, name) =>
    Object.hasOwn(values, name) ? values[name] : slot,
  );
}
