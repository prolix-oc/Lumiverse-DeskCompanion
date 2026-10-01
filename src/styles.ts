export const STYLES = `
.dc-shell,.dc-about { box-sizing:border-box; color:var(--lumiverse-text,#eeeaf8); font:13px/1.5 system-ui,-apple-system,sans-serif; }
.dc-shell *,.dc-about * { box-sizing:border-box; }
.dc-shell { width:100%; height:100%; min-height:0; max-height:100%; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; touch-action:pan-y; user-select:text; padding:18px; background:var(--lumiverse-bg,#191724); border-radius:12px; scrollbar-width:thin; }
.dc-settings { height:auto; max-height:none; overflow:visible; margin-top:20px; }
.dc-widget .dc-destination { white-space:pre-wrap; }
.dc-shell header { display:flex; gap:12px; align-items:center; margin-bottom:16px; }
.dc-mark { display:grid; place-items:center; width:42px; height:42px; flex-shrink:0; border-radius:14px; color:#d5f8ee; background:linear-gradient(135deg,#456b65,#55456f); font-size:22px; }
.dc-shell h2,.dc-about h2 { font-size:17px; margin:0; letter-spacing:-.3px; }
.dc-subtitle,.dc-note { color:var(--lumiverse-text-muted,#aba4bf); font-size:11px; }
.dc-badge { margin-left:auto; color:#aff0d7; font-size:10px; border:1px solid #40685b; border-radius:20px; padding:3px 8px; white-space:nowrap; }
.dc-badge[data-busy=true] { color:#ecd3ff; border-color:#805794; }
.dc-field { display:block; margin:10px 0; font-size:11px; font-weight:600; letter-spacing:.15px; }
.dc-shell select,.dc-shell textarea,.dc-shell input:not([type=checkbox]) { display:block; margin-top:5px; width:100%; padding:8px 10px; border:1px solid var(--lumiverse-border,#42394f); border-radius:8px; background:var(--lumiverse-fill,#252030); color:inherit; font:inherit; outline:none; }
.dc-shell textarea { resize:vertical; min-height:75px; font-weight:400; }
.dc-shell :is(select,input,textarea):focus { border-color:#91cfba; box-shadow:0 0 0 2px #91cfba22; }
.dc-shell button,.dc-about button { padding:7px 10px; background:var(--lumiverse-fill,#302938); color:inherit; border:1px solid var(--lumiverse-border,#554961); border-radius:8px; font:inherit; cursor:pointer; }
.dc-shell button:hover:not(:disabled),.dc-about button:hover:not(:disabled) { background:#4d3d58; }
.dc-shell button:disabled,.dc-shell :is(input,textarea,select):disabled { opacity:.5; cursor:not-allowed; }
.dc-row { display:flex; align-items:center; gap:8px; }
.dc-row > .dc-field { flex:1; min-width:0; }
.dc-page { display:flex; justify-content:space-between; gap:8px; align-items:center; color:var(--lumiverse-text-muted,#aaa0bc); font-size:10px; }
.dc-page button { font-size:10px; padding:3px 8px; }
.dc-destination { padding:9px 11px; border-radius:8px; background:#6cbfa311; border:1px solid #6cbfa32b; color:#bae9d6; font-size:11px; overflow-wrap:anywhere; }
.dc-shell .dc-primary { background:#a8dbc8; border-color:#a8dbc8; color:#172820; font-weight:700; flex:1; }
.dc-shell .dc-primary:hover:not(:disabled) { background:#c2ebde; }
.dc-actions { margin:13px 0; }
.dc-status { min-height:36px; font-size:11px; color:var(--lumiverse-text-muted,#c2b5d0); white-space:pre-wrap; overflow-wrap:anywhere; }
.dc-status[data-error=true] { color:#ffb3b8; }
.dc-reply { margin:10px 0; padding:13px; min-height:80px; max-height:210px; overflow:auto; border-radius:10px; border:1px solid var(--lumiverse-border,#48394f); background:var(--lumiverse-fill-subtle,#241e2c); }
.dc-reply-name { font-size:11px; font-weight:700; color:#d9bee9; margin-bottom:7px; }
.dc-reply-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.dc-shell details { border-top:1px solid var(--lumiverse-border,#42394f); padding-top:11px; margin-top:12px; }
.dc-shell summary { cursor:pointer; font-weight:600; font-size:12px; }
.dc-option { display:flex; align-items:flex-start; gap:8px; margin:10px 0; font-size:11px; }
.dc-option input { flex-shrink:0; margin-top:3px; accent-color:#a8dbc8; }
.dc-shell audio { display:block; width:100%; height:36px; margin-top:9px; }
.dc-shell [hidden] { display:none!important; }
.dc-footer { display:flex; justify-content:space-between; margin-top:13px; font-size:10px; color:var(--lumiverse-text-muted,#aa9bb8); }
.dc-footer button { font-size:10px; }
.dc-about { padding:24px; max-width:650px; }
.dc-about p,.dc-about li { color:var(--lumiverse-text-muted,#aba4bf); }
.dc-about .dc-row { margin-top:18px; }
`;
