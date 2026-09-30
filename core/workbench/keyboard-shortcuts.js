/** Resolve only app shortcuts that are safe in the current focus/context. */
export function resolveKeyboardShortcut(event, { editing = false, searchAvailable = false, selectable = false, textureWorkspace = false } = {}) {
  if (!event || editing || !(event.metaKey || event.ctrlKey)) return null;
  const key = String(event.key || "").toLowerCase();
  if (key === "k") return "command-palette";
  if (key === "p") return "quick-open";
  if (key === "f") return searchAvailable ? "workspace-search" : null;
  if (key === "a") return selectable ? "select-visible" : null;
  if (key === "z") return textureWorkspace ? (event.shiftKey ? "texture-redo" : "texture-undo") : (event.shiftKey ? "redo" : "undo");
  if (key === "y") return "redo";
  return null;
}
