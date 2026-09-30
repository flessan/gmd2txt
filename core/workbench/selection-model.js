export class SelectionModel {
  constructor(ids = []) { this.selected = new Set(); this.anchor = null; this.setVisible(ids); }
  setVisible(ids = []) { this.visible = [...new Set(ids.map(String))]; this.selected = new Set([...this.selected].filter(id => this.visible.includes(id))); if (!this.visible.includes(this.anchor)) this.anchor = null; return this; }
  has(id) { return this.selected.has(String(id)); }
  values() { return [...this.selected]; }
  get size() { return this.selected.size; }
  clear() { this.selected.clear(); this.anchor = null; }
  select(id, { additive = false, range = false, toggle = false } = {}) {
    id = String(id); const index = this.visible.indexOf(id); if (index < 0) return this.values();
    if (range && this.anchor && this.visible.includes(this.anchor)) {
      const start = this.visible.indexOf(this.anchor), lo = Math.min(start, index), hi = Math.max(start, index);
      if (!additive) this.selected.clear();
      for (const item of this.visible.slice(lo, hi + 1)) this.selected.add(item);
    } else if (toggle) {
      if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
      this.anchor = id;
    } else {
      if (!additive) this.selected.clear();
      this.selected.add(id); this.anchor = id;
    }
    return this.values();
  }
  toggleAll() { if (this.visible.length && this.visible.every(id => this.selected.has(id))) this.clear(); else { this.selected = new Set(this.visible); this.anchor = this.visible[0] || null; } return this.values(); }
  selectAll() { this.selected = new Set(this.visible); this.anchor = this.visible[0] || null; return this.values(); }
  move(id, direction, { additive = false } = {}) { const index = this.visible.indexOf(String(id)); const next = this.visible[Math.max(0, Math.min(this.visible.length - 1, (index < 0 ? 0 : index) + direction))]; return next ? this.select(next, { additive, range: additive }) : this.values(); }
}
