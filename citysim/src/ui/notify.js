/**
 * Toasts.
 *
 * A toast appears when an alert *starts* — it is edge-triggered off the derived
 * alert list, so nothing is announced twice and nothing is announced that is not
 * true right now. Non-critical toasts retire themselves; a critical one stays
 * until the condition clears or the reader dismisses it. Messages pushed by hand
 * (`push`) are not tied to the alert list and expire only on their own timer.
 */
import { h } from './dom.js';
import { icon } from './icons.js';

const TTL = { good: 7000, warning: 11000, serious: 14000, critical: Infinity };

export function createToasts() {
  const el = h('div.toasts', { 'aria-live': 'polite' });
  const shown = new Map();   // id -> { node, until, manual }

  function push(a, nowMs, manual = false) {
    if (shown.has(a.id)) return;
    const node = h('div', { class: `toast ${a.level}` },
      h('span.ic', null, icon(a.icon, 15)),
      h('div.bd', null,
        h('div.ti', { text: a.title }),
        h('div.ms', { text: a.message })),
      h('button.iconbtn', {
        type: 'button', title: 'Dismiss', style: { width: '20px', height: '20px', marginLeft: 'auto' },
        onclick: () => drop(a.id),
      }, icon('close', 11)));
    const ttl = manual ? 9000 : (TTL[a.level] ?? 9000);
    shown.set(a.id, { node, until: nowMs + ttl, manual });
    el.appendChild(node);
    // never let the stack grow past three
    while (el.childElementCount > 3) {
      const first = el.firstElementChild;
      for (const [k, v] of shown) if (v.node === first) { shown.delete(k); break; }
      first.remove();
    }
  }

  function drop(id) {
    const e = shown.get(id);
    if (!e) return;
    e.node.remove();
    shown.delete(id);
  }

  /** `alerts` is the full current list; `nowMs` a monotonic clock. */
  function update(alerts, nowMs) {
    const live = new Set(alerts.map((a) => a.id));
    for (const a of alerts) if (a.level !== 'good') push(a, nowMs);
    for (const [id, e] of [...shown]) {
      if (nowMs > e.until) { drop(id); continue; }
      if (!e.manual && !live.has(id)) drop(id);
    }
  }

  function clearAll() {
    for (const id of [...shown.keys()]) drop(id);
  }

  return { el, update, push: (a, nowMs) => push(a, nowMs, true), clearAll };
}

export default createToasts;
