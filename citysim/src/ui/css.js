/**
 * The whole stylesheet, as one string. Injected into a single <style> element
 * that dispose() removes. Everything is scoped under #ui-root so the module can
 * never restyle the page it is a guest on.
 */
import { TOKENS as T } from './tokens.js';

export const CSS = `
#ui-root {
  --font: ${T.font};
  --ink-0: ${T.ink[0]};
  --ink-1: ${T.ink[1]};
  --ink-2: ${T.ink[2]};
  --ink-3: ${T.ink[3]};
  --accent: ${T.accent};
  --accent-ink: ${T.accentInk};
  --surface: ${T.surface};

  --good: ${T.status.good};
  --warning: ${T.status.warning};
  --serious: ${T.status.serious};
  --critical: ${T.status.critical};

  /* one elevation model: glass + hairline + inset top light + soft drop */
  --glass-1: rgba(12, 17, 24, 0.80);
  --glass-2: rgba(14, 20, 28, 0.86);
  --line: rgba(255, 255, 255, 0.085);
  --line-strong: rgba(255, 255, 255, 0.16);
  --wash: rgba(255, 255, 255, 0.05);
  --wash-2: rgba(255, 255, 255, 0.09);
  --sel: rgba(92, 179, 242, 0.16);
  --shadow: 0 10px 34px rgba(0, 0, 0, 0.42), 0 2px 6px rgba(0, 0, 0, 0.30);
  --inset: inset 0 1px 0 rgba(255, 255, 255, 0.055);

  position: fixed; inset: 0; z-index: 40;
  pointer-events: none;
  font-family: var(--font);
  font-size: ${T.type.sm}px;
  line-height: 1.35;
  color: var(--ink-0);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
#ui-root * { box-sizing: border-box; margin: 0; }
#ui-root button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
#ui-root svg { display: block; }
#ui-root .num { font-variant-numeric: tabular-nums; }

/* every interactive surface opts back in */
#ui-root .ix { pointer-events: auto; }

/* ---------------------------------------------------------------- glass -- */
#ui-root .panel {
  background: var(--glass-1);
  -webkit-backdrop-filter: blur(20px) saturate(1.25);
  backdrop-filter: blur(20px) saturate(1.25);
  border: 1px solid var(--line);
  border-radius: ${T.radius.md}px;
  box-shadow: var(--shadow), var(--inset);
}
#ui-root .panel-hd {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px 8px;
  border-bottom: 1px solid var(--line);
}
#ui-root .panel-hd h2 {
  font-size: ${T.type.micro}px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--ink-2); flex: 1;
}
#ui-root .panel-bd { padding: 10px 12px 12px; }

#ui-root .eyebrow {
  font-size: ${T.type.micro}px; font-weight: 700; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--ink-2);
}
#ui-root .hint { font-size: ${T.type.xs}px; color: var(--ink-3); }

#ui-root .iconbtn {
  display: grid; place-items: center; width: 26px; height: 26px;
  border-radius: ${T.radius.sm}px; color: var(--ink-2);
}
#ui-root .iconbtn:hover { background: var(--wash); color: var(--ink-0); }

/* ================================================================ TOP BAR = */
#ui-root .topbar {
  position: absolute; top: 0; left: 0; right: 0; height: 46px;
  display: flex; align-items: stretch;
  background: linear-gradient(180deg, rgba(8,12,18,0.92) 0%, rgba(9,13,19,0.86) 62%, rgba(9,13,19,0.80) 100%);
  -webkit-backdrop-filter: blur(20px) saturate(1.25);
  backdrop-filter: blur(20px) saturate(1.25);
  border-bottom: 1px solid rgba(255, 255, 255, 0.13);
  box-shadow: 0 10px 26px rgba(0,0,0,0.30);
  pointer-events: auto;
}
/* a scrim below the bar so it sits on the sky instead of being pasted on it */
#ui-root .topbar::after {
  content: ''; position: absolute; left: 0; right: 0; top: 100%; height: 26px;
  background: linear-gradient(180deg, rgba(6,9,14,0.34), rgba(6,9,14,0));
  pointer-events: none;
}
#ui-root .tb-l { display: flex; align-items: center; gap: 14px; padding-left: 14px; }
#ui-root .tb-c { flex: 1; display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; padding: 0 14px; }
#ui-root .tb-r { display: flex; align-items: center; gap: 12px; padding-right: 12px; }
#ui-root .tb-sep { width: 1px; align-self: stretch; margin: 9px 0; background: var(--line); }

#ui-root .city { display: flex; align-items: center; gap: 9px; }
#ui-root .city .crest { color: var(--accent); opacity: 0.92; }
#ui-root .city .nm { font-size: ${T.type.md}px; letter-spacing: 0.055em; text-transform: uppercase; }
#ui-root .city .sub { font-size: ${T.type.micro}px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); }

#ui-root .stat { display: flex; align-items: center; gap: 8px; }
#ui-root .stat .gl { color: var(--ink-3); }
#ui-root .stat .tx { display: flex; flex-direction: column; }
#ui-root .stat .v { font-size: ${T.type.lg}px; letter-spacing: -0.005em; line-height: 1.05; }
#ui-root .stat .k { font-size: ${T.type.micro}px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); margin-top: 1px; }
#ui-root .stat .d { font-size: ${T.type.micro}px; letter-spacing: 0.02em; }
#ui-root .up { color: var(--good); }
#ui-root .down { color: var(--critical); }
#ui-root .flat { color: var(--ink-3); }

/* alert chips — icon + label, never colour alone */
#ui-root .chips { display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; overflow: hidden; }
#ui-root .chip {
  display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
  height: 24px; padding: 0 9px 0 7px;
  border-radius: ${T.radius.pill}px;
  border: 1px solid var(--line);
  background: rgba(255,255,255,0.045);
  font-size: ${T.type.xs}px; color: var(--ink-1); white-space: nowrap;
}
#ui-root .chip svg { opacity: 0.95; }
#ui-root .chip.good    { border-color: rgba(12,163,12,0.42);  color: #b7e6b7; background: rgba(12,163,12,0.13); }
#ui-root .chip.warning { border-color: rgba(250,178,25,0.40); color: #f6dca4; background: rgba(250,178,25,0.12); }
#ui-root .chip.serious { border-color: rgba(236,131,90,0.44); color: #f4c3ab; background: rgba(236,131,90,0.13); }
#ui-root .chip.critical{ border-color: rgba(208,59,59,0.52);  color: #f3b3b3; background: rgba(208,59,59,0.16); }
#ui-root .chip .cw { color: currentColor; }

/* clock + speed */
#ui-root .clock { display: flex; flex-direction: column; align-items: flex-end; }
#ui-root .clock .t { font-size: ${T.type.xl}px; letter-spacing: 0.01em; line-height: 1; }
#ui-root .clock .d { font-size: ${T.type.micro}px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-2); margin-top: 3px; }
#ui-root .speed {
  display: flex; align-items: center; gap: 2px; padding: 3px;
  border: 1px solid var(--line); border-radius: ${T.radius.sm}px;
  background: rgba(0,0,0,0.24);
}
#ui-root .speed button {
  display: grid; place-items: center; height: 24px; min-width: 26px; padding: 0 6px;
  border-radius: ${T.radius.xs}px; color: var(--ink-2);
}
#ui-root .speed button:hover { background: var(--wash); color: var(--ink-0); }
#ui-root .speed button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
#ui-root .speed .lbl { font-size: ${T.type.xs}px; letter-spacing: 0.04em; }

/* ================================================================== DOCK == */
#ui-root .dock { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; }

#ui-root .subrow {
  display: flex; align-items: stretch; gap: 4px; padding: 6px;
  background: var(--glass-2);
  -webkit-backdrop-filter: blur(20px) saturate(1.25);
  backdrop-filter: blur(20px) saturate(1.25);
  border: 1px solid var(--line); border-radius: ${T.radius.md}px;
  box-shadow: var(--shadow), var(--inset);
  pointer-events: auto;
}
#ui-root .subrow .tool {
  display: flex; align-items: center; gap: 7px; height: 34px; padding: 0 10px 0 8px;
  white-space: nowrap;
  border-radius: ${T.radius.sm}px; color: var(--ink-1); font-size: ${T.type.sm}px;
  border: 1px solid transparent;
}
#ui-root .subrow .tool:hover { background: var(--wash); color: var(--ink-0); }
#ui-root .subrow .tool[aria-pressed="true"] {
  background: var(--sel); border-color: rgba(92,179,242,0.42); color: var(--ink-0);
}
#ui-root .subrow .tool[aria-pressed="true"] .sw { opacity: 1; }
#ui-root .kbd {
  font-size: ${T.type.micro}px; color: var(--ink-3); border: 1px solid var(--line);
  border-radius: ${T.radius.xs}px; padding: 0 4px; line-height: 14px; min-width: 15px;
  text-align: center; flex: 0 0 auto;
}
#ui-root .tool[aria-pressed="true"] .kbd { color: var(--ink-1); border-color: var(--line-strong); }
#ui-root .sw { width: 9px; height: 9px; border-radius: 2px; opacity: 0.85; flex: 0 0 auto; }

#ui-root .cats {
  display: flex; align-items: stretch; gap: 2px; padding: 6px;
  background: var(--glass-2);
  -webkit-backdrop-filter: blur(22px) saturate(1.25);
  backdrop-filter: blur(22px) saturate(1.25);
  border: 1px solid var(--line); border-radius: ${T.radius.lg}px;
  box-shadow: var(--shadow), var(--inset);
  pointer-events: auto;
}
#ui-root .cat {
  position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; width: 74px; height: 56px; border-radius: ${T.radius.md}px; color: var(--ink-2);
}
#ui-root .cat .cl { font-size: ${T.type.micro}px; letter-spacing: 0.085em; text-transform: uppercase; }
#ui-root .cat:hover { background: var(--wash); color: var(--ink-0); }
#ui-root .cat[aria-pressed="true"] { background: var(--sel); color: var(--ink-0); }
#ui-root .cat[aria-pressed="true"]::after {
  content: ''; position: absolute; left: 18px; right: 18px; bottom: 5px; height: 2px;
  border-radius: 2px; background: var(--accent);
}
#ui-root .cat .k {
  position: absolute; top: 5px; right: 7px; font-size: ${T.type.micro}px; color: var(--ink-3);
}
#ui-root .cat[aria-pressed="true"] .k { color: var(--accent); }
#ui-root .cat.disabled { opacity: 0.4; }

/* ============================================================== OVERLAYS == */
#ui-root .rail { position: absolute; left: 14px; top: 60px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
#ui-root .ovbar {
  display: flex; align-items: center; gap: 2px; padding: 5px;
  background: var(--glass-1);
  -webkit-backdrop-filter: blur(20px) saturate(1.25);
  backdrop-filter: blur(20px) saturate(1.25);
  border: 1px solid var(--line); border-radius: ${T.radius.md}px;
  box-shadow: var(--shadow), var(--inset); pointer-events: auto;
}
#ui-root .ovbar .lb {
  font-size: ${T.type.micro}px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--ink-3); padding: 0 9px 0 6px; margin-right: 4px;
  border-right: 1px solid var(--line); align-self: stretch; display: flex; align-items: center;
}
#ui-root .ov {
  display: grid; place-items: center; width: 32px; height: 30px;
  border-radius: ${T.radius.sm}px; color: var(--ink-1);
}
#ui-root .ov:hover { background: var(--wash); color: var(--ink-0); }
#ui-root .ov[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }

#ui-root .legend { width: 216px; }
#ui-root .legend .ramp { height: 8px; border-radius: 2px; margin: 2px 0 6px; }
#ui-root .legend .ends { display: flex; justify-content: space-between; font-size: ${T.type.micro}px; color: var(--ink-2); }
#ui-root .legend .rows { display: flex; flex-direction: column; gap: 5px; margin-top: 2px; }
#ui-root .legend .row { display: flex; align-items: center; gap: 7px; font-size: ${T.type.xs}px; color: var(--ink-1); }
#ui-root .legend .row .v { margin-left: auto; color: var(--ink-2); }

/* ============================================================= INSPECTOR == */
#ui-root .inspector { position: absolute; right: 14px; top: 60px; width: 312px; pointer-events: auto; }
#ui-root .insp-title { display: flex; align-items: baseline; gap: 8px; }
#ui-root .insp-title h3 { font-size: ${T.type.lg}px; font-weight: 400; letter-spacing: 0.005em; }
#ui-root .insp-title .tag {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: ${T.type.micro}px; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--ink-2); border: 1px solid var(--line); border-radius: ${T.radius.xs}px; padding: 2px 6px;
}
#ui-root .dotc { width: 7px; height: 7px; border-radius: 2px; flex: 0 0 auto; }
#ui-root .addr { display: flex; align-items: center; gap: 5px;
  font-size: ${T.type.xs}px; color: var(--ink-2); margin-top: 4px; }
#ui-root .kv { display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; margin-top: 10px; }
#ui-root .kv dt { font-size: ${T.type.xs}px; color: var(--ink-2); }
#ui-root .kv dd { font-size: ${T.type.sm}px; color: var(--ink-0); text-align: right; }
#ui-root .meter { height: 4px; border-radius: 2px; background: rgba(255,255,255,0.10); overflow: hidden; margin-top: 7px; }
#ui-root .meter i { display: block; height: 100%; border-radius: 2px; }
#ui-root .sect { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
#ui-root .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px 8px 12px; text-align: center; }
#ui-root .empty .ic { color: var(--ink-3); }
#ui-root .empty p { font-size: ${T.type.xs}px; color: var(--ink-2); max-width: 24ch; }

/* ============================================================ STATISTICS == */
#ui-root .stats { position: absolute; left: 14px; bottom: 148px; width: 418px; pointer-events: auto;
  max-height: calc(100% - 200px); display: flex; flex-direction: column; }
#ui-root .stats .panel-bd { padding: 0 12px 10px; overflow-y: auto; flex: 1; min-height: 0; }
#ui-root .chart { padding: 8px 0 7px; border-bottom: 1px solid var(--line); }
#ui-root .chart:nth-last-child(-n+2) { border-bottom: 0; padding-bottom: 2px; }
#ui-root .chart-hd { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
#ui-root .chart-hd .t { font-size: ${T.type.xs}px; color: var(--ink-1); letter-spacing: 0.01em; }
#ui-root .chart-hd .u { font-size: ${T.type.micro}px; color: var(--ink-3); }
#ui-root .chart-hd .now { margin-left: auto; font-size: ${T.type.md}px; color: var(--ink-0); }
#ui-root .keys { display: flex; gap: 9px; margin-top: 3px; flex-wrap: wrap; }
#ui-root .key { display: flex; align-items: center; gap: 4px; font-size: ${T.type.micro}px; color: var(--ink-2); }
#ui-root .key .kd { width: 7px; height: 7px; border-radius: 999px; flex: 0 0 auto; }
#ui-root .key .kval { color: var(--ink-1); }
#ui-root .chart svg { width: 100%; height: auto; overflow: visible; }
#ui-root .chart .axis { fill: var(--ink-3); font-size: 9px; }

/* =========================================================== NOTIFICATION = */
#ui-root .toasts { position: absolute; right: 14px; bottom: 148px; width: 296px; display: flex; flex-direction: column; gap: 8px; align-items: stretch; }
#ui-root .toast {
  display: flex; gap: 10px; padding: 10px 11px;
  background: var(--glass-1);
  -webkit-backdrop-filter: blur(20px) saturate(1.25);
  backdrop-filter: blur(20px) saturate(1.25);
  border: 1px solid var(--line); border-left-width: 2px; border-radius: ${T.radius.sm}px;
  box-shadow: var(--shadow), var(--inset);
  pointer-events: auto;
  animation: ui-in 260ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes ui-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
#ui-root .toast.good     { border-left-color: var(--good); }
#ui-root .toast.warning  { border-left-color: var(--warning); }
#ui-root .toast.serious  { border-left-color: var(--serious); }
#ui-root .toast.critical { border-left-color: var(--critical); }
#ui-root .toast .ic { flex: 0 0 auto; margin-top: 1px; }
#ui-root .toast.good .ic     { color: var(--good); }
#ui-root .toast.warning .ic  { color: var(--warning); }
#ui-root .toast.serious .ic  { color: var(--serious); }
#ui-root .toast.critical .ic { color: var(--critical); }
#ui-root .toast .bd { min-width: 0; }
#ui-root .toast .ti { font-size: ${T.type.sm}px; color: var(--ink-0); }
#ui-root .toast .ms { font-size: ${T.type.xs}px; color: var(--ink-2); margin-top: 2px; }

/* ============================================================ FAIL BADGE == */
#ui-root .failbar { display: flex; gap: 6px; flex-wrap: wrap; }
#ui-root .failbadge {
  display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 9px 0 7px;
  border-radius: ${T.radius.pill}px; pointer-events: auto;
  border: 1px solid rgba(208,59,59,0.55); background: rgba(38,12,14,0.86);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
  font-size: ${T.type.xs}px; color: #f3b3b3;
}
#ui-root .failbadge .ic { color: var(--critical); }

/* ============================================================ PHOTO MODE == */
#ui-root.photo .topbar,
#ui-root.photo .dock,
#ui-root.photo .rail,
#ui-root.photo .inspector,
#ui-root.photo .stats,
#ui-root.photo .toasts,
#ui-root.photo .failbar { display: none; }
#ui-root .photobar { display: none; }
#ui-root.photo .photobar {
  display: flex; position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%);
  align-items: center; gap: 3px; padding: 5px 6px;
  background: rgba(8, 11, 16, 0.62);
  -webkit-backdrop-filter: blur(18px) saturate(1.2); backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid var(--line); border-radius: ${T.radius.pill}px;
  box-shadow: var(--shadow); pointer-events: auto;
}
#ui-root .photobar .pl {
  font-size: ${T.type.micro}px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
  color: var(--ink-3); padding: 0 10px 0 8px;
}
#ui-root .photobar button {
  height: 26px; padding: 0 11px; border-radius: ${T.radius.pill}px; white-space: nowrap;
  font-size: ${T.type.xs}px; letter-spacing: 0.05em; color: var(--ink-1);
}
#ui-root .photobar button:hover { background: var(--wash-2); color: var(--ink-0); }
#ui-root .photobar button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
#ui-root .photobar .esc { font-size: ${T.type.micro}px; color: var(--ink-3); white-space: nowrap;
  padding: 0 10px 0 11px; border-left: 1px solid var(--line); margin-left: 5px;
  letter-spacing: 0.06em; }
#ui-root .thirds { display: none; position: absolute; inset: 0; }
#ui-root.photo .thirds { display: block; }
#ui-root .thirds i { position: absolute; background: rgba(255,255,255,0.10); }
#ui-root .thirds i.v { top: 6%; bottom: 6%; width: 1px; }
#ui-root .thirds i.h { left: 6%; right: 6%; height: 1px; }

/* HUD hidden entirely (H) */
#ui-root.hidden > * { display: none !important; }
`;

export default CSS;
