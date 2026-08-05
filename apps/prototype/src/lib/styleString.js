// The source prototype authors styles as CSS strings (dc-runtime accepted them
// on the style attribute); React wants objects. Same conversion dc-runtime did.
export function sx(css) {
  if (!css) return undefined;
  const o = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    o[prop.startsWith("--") ? prop : prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = decl.slice(i + 1).trim();
  }
  return o;
}
