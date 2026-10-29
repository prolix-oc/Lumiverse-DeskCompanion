export const STYLES = `
.dc-shell,.dc-about { box-sizing:border-box; color:var(--lumiverse-text,#eeeaf8); font:calc(13px * var(--lumiverse-font-scale,1))/1.5 system-ui,-apple-system,sans-serif; }
.dc-shell *,.dc-about * { box-sizing:border-box; }
.dc-shell [hidden],.dc-about [hidden] { display:none!important; }
.dc-shell { width:100%; height:100%; min-height:0; max-height:100%; overflow-y:auto; overflow-x:hidden; overscroll-behavior:contain; touch-action:pan-y; user-select:text; scrollbar-width:thin; padding:16px; }
.dc-widget { display:flex; flex-direction:column; background:var(--lumiverse-bg-elevated,#1c1923); }
.dc-settings { height:auto; max-height:none; overflow:visible; padding:0; }
.dc-header { display:flex; gap:10px; align-items:center; min-height:32px; margin-bottom:16px; }
.dc-header h2 { font-size:16px; font-weight:600; letter-spacing:-.3px; margin:0; }
.dc-badge,.dc-badge-host { margin-left:auto; flex-shrink:0; }
.dc-badge { color:var(--lumiverse-text-muted,#b5afc2); font-size:11px; padding:2px 8px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:20px; }
.dc-note { margin:6px 0; color:var(--lumiverse-text-dim,#9e97ad); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.dc-note:empty,.dc-status:empty { display:none; }
.dc-field { display:flex; flex-direction:column; min-width:0; gap:6px; margin:0 0 16px; font-size:13px; }
.dc-field > span:first-child { color:var(--lumiverse-text-muted,#b5afc2); font-weight:500; }
.dc-optional { margin-left:6px; color:var(--lumiverse-text-dim,#9e97ad); font-size:11px; font-weight:400; }
.dc-control { display:block; min-width:0; width:100%; }
.dc-native:not([type=checkbox]) { display:block; width:100%; padding:10px 12px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:8px; background:var(--lumiverse-fill-subtle,#ffffff05); color:inherit; font:inherit; }
textarea.dc-native { resize:vertical; min-height:92px; }
.dc-native:focus-visible,.dc-button:focus-visible { outline:2px solid var(--lumiverse-primary,#b59bd6); outline-offset:2px; }
.dc-native:disabled { opacity:.5; }
.dc-button { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:8px 12px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:8px; background:var(--lumiverse-fill-subtle,#ffffff05); color:var(--lumiverse-text,#eeeaf8); font:inherit; line-height:1.4; cursor:pointer; transition:background .15s,border-color .15s; }
.dc-button:hover:not(:disabled) { background:var(--lumiverse-fill-hover,#ffffff0a); border-color:var(--lumiverse-border-hover,#51475e); }
.dc-button:disabled { opacity:.45; cursor:not-allowed; }
.dc-icon-button { padding:6px; border-color:transparent; background:transparent; color:var(--lumiverse-text-muted,#b5afc2); }
.dc-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.dc-grid:has(> [data-role=duration-field][hidden]) { grid-template-columns:1fr; }
.dc-page { display:flex; justify-content:space-between; align-items:center; gap:8px; margin:-6px 0 18px; color:var(--lumiverse-text-dim,#9e97ad); font-size:11px; }
.dc-page .dc-button { font-size:11px; padding:4px 8px; }
.dc-tabs { display:flex; gap:20px; margin-bottom:24px; border-bottom:1px solid var(--lumiverse-border,#3b3548); }
.dc-tabs .dc-button { border:0; border-radius:0; border-bottom:2px solid transparent; padding:10px 0; background:transparent; color:var(--lumiverse-text-dim,#9e97ad); font-weight:500; }
.dc-tabs .dc-button[aria-selected=true] { color:var(--lumiverse-primary,#b59bd6); border-bottom-color:var(--lumiverse-primary,#b59bd6); }
.dc-tabs .dc-button:hover { background:transparent; color:var(--lumiverse-text,#eeeaf8); }
.dc-group { margin-bottom:24px; }
.dc-group + .dc-group { border-top:1px solid var(--lumiverse-border,#3b3548); padding-top:24px; }
.dc-group h3 { margin:0; font-size:14px; font-weight:600; }
.dc-toggle-row { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:16px; }
.dc-toggle-row .dc-note { margin:3px 0 0; }
.dc-toggle-row > .dc-control { width:auto; flex-shrink:0; }
.dc-keybindings { margin:16px 0; }
.dc-settings details[data-shared-section] { margin-top:20px; padding-top:12px; border-top:1px solid var(--lumiverse-border,#3b3548); }
.dc-settings details[data-shared-section] > summary { color:var(--lumiverse-text-muted,#b5afc2); cursor:pointer; font-weight:500; }
.dc-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:24px; padding-top:16px; border-top:1px solid var(--lumiverse-border,#3b3548); color:var(--lumiverse-text-dim,#9e97ad); font-size:11px; }
.dc-footer .dc-button { font-size:12px; }
.dc-status { margin-top:12px; color:var(--lumiverse-text-muted,#b5afc2); font-size:12px; overflow-wrap:anywhere; }
.dc-status[data-error=true] { color:var(--lumiverse-danger,#f099a5); }
.dc-widget [data-view=triggers] { display:flex; flex-direction:column; flex:1; min-height:0; }
.dc-actions { margin-bottom:14px; }
.dc-primary { flex:1; background:var(--lumiverse-primary,#b59bd6); border-color:var(--lumiverse-primary,#b59bd6); color:var(--lumiverse-primary-contrast,var(--lumiverse-text,#eeeaf8)); font-weight:600; padding:11px 14px; }
.dc-primary:hover:not(:disabled) { background:var(--lumiverse-primary-hover,#c5afe0); border-color:var(--lumiverse-primary-hover,#c5afe0); }
.dc-reply { flex:1; min-height:100px; max-height:360px; overflow:auto; padding:14px; border:1px solid var(--lumiverse-border,#3b3548); border-radius:10px; background:var(--lumiverse-fill-subtle,#ffffff05); }
.dc-reply-name { color:var(--lumiverse-primary,#b59bd6); font-size:12px; font-weight:600; margin-bottom:8px; }
.dc-reply-text { white-space:pre-wrap; overflow-wrap:anywhere; }
.dc-reply[data-empty=true] .dc-reply-text { color:var(--lumiverse-text-muted,#b5afc2); }
.dc-reply-actions { display:flex; align-items:center; gap:8px; margin-top:10px; }
.dc-reply-actions .dc-button { padding:6px 9px; font-size:12px; }
.dc-reply-actions [data-role=clear] { margin-left:auto; }
.dc-about { padding:24px; width:100%; max-width:760px; margin:0 auto; }
.dc-launcher { display:flex; align-items:center; gap:8px; margin-left:auto; }
.dc-launcher .dc-button { font-size:12px; padding:7px 10px; }
@media(max-width:420px) { .dc-about { padding:16px; } .dc-header { flex-wrap:wrap; } .dc-settings .dc-badge,.dc-settings .dc-badge-host { display:none; } .dc-tabs { gap:18px; } .dc-grid { gap:12px; } }
`;
