/**
 * Minimal DOM helpers. No framework, no innerHTML on anything that could ever
 * carry data — every string that comes from the world model goes through
 * textContent.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** h('div.cls#id', {attrs}, ...children) */
export function h(spec, attrs = null, ...kids) {
  const m = /^([a-z0-9]+)?((?:[.#][^.#]+)*)$/i.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) {
    for (const tok of m[2].match(/[.#][^.#]+/g) || []) {
      if (tok[0] === '#') el.id = tok.slice(1);
      else el.classList.add(tok.slice(1));
    }
  }
  apply(el, attrs);
  add(el, kids);
  return el;
}

/** svg('path', {d:…}) — namespaced element. */
export function s(tag, attrs = null, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  add(el, kids);
  return el;
}

function apply(el, attrs) {
  if (!attrs) return;
  for (const k in attrs) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function add(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
  }
}

/** Write only when the value actually changed — the cheapest DOM write is none. */
export function setText(el, value) {
  if (!el) return false;
  const v = value === null || value === undefined ? '' : String(value);
  if (el.__t === v) return false;
  el.__t = v;
  el.textContent = v;
  return true;
}

export function setClass(el, name, on) {
  if (!el) return;
  const key = '__c_' + name;
  if (el[key] === !!on) return;
  el[key] = !!on;
  el.classList.toggle(name, !!on);
}

export function setAttr(el, name, value) {
  if (!el) return;
  const key = '__a_' + name;
  const v = value === null || value === undefined ? null : String(value);
  if (el[key] === v) return;
  el[key] = v;
  if (v === null) el.removeAttribute(name);
  else el.setAttribute(name, v);
}

/** Set a style property only when it changed (avoids needless style recalcs). */
export function setStyle(el, prop, value) {
  if (!el) return;
  const key = '__s_' + prop;
  const v = String(value);
  if (el[key] === v) return;
  el[key] = v;
  el.style.setProperty(prop, v);
}

export function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

export default h;
