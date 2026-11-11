/**
 * Trading workspace frame styles. Injected as a style element: the client build scopes imported
 * `.css` files to the onboarding surface, so these rules must not be a stylesheet import.
 */
const STYLES = `
.dshTwFrame {
  --dsh-tw-caption-height: 0px;
  position: relative;
  display: grid;
  grid-template-rows: var(--dsh-tw-caption-height) minmax(0, 1fr) auto;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
.dshTwFrame[data-tw-caption] { --dsh-tw-caption-height: 40px; }
html[data-windows-titlebar] .dshTwFrame[data-tw-caption] { --dsh-tw-caption-height: var(--dsh-windows-titlebar-height, 40px); }
html[data-platform='darwin'][data-fullscreen] .dshTwFrame[data-tw-caption] { --dsh-tw-caption-height: 0px; }
/* The caption row clears the traffic lights, so pages inside the frame add no window-strip clearance. */
html[data-platform='darwin'] .dshTwFrame { --dsh-frame-top-clearance: 0px; }

.dshTwCaption {
  grid-row: 1;
  grid-column: 1 / -1;
  min-width: 0;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill);
  border-bottom: 0.5px solid var(--dsw-alias-border-l3);
  -webkit-app-region: drag;
}

.dshTwActivityBar {
  grid-row: 2;
  grid-column: 1;
  position: relative;
  z-index: 72;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill);
  border-right: 0.5px solid var(--dsw-alias-border-l3);
}
.dshTwActivityButton {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.dshTwActivityButton:hover { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.dshTwActivityButton[aria-pressed='true'] { color: var(--dsw-alias-label-primary); background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }
.dshTwActivityButton[aria-pressed='true']::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 0 2px 2px 0;
  background: var(--dsw-alias-brand-primary, currentColor);
}
.dshTwActivityButton:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset: 1px; }

.dshTwSidebarCol {
  grid-row: 2;
  grid-column: 2;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--dsw-specific-sidebar-fill);
  border-right: 0.5px solid var(--dsw-alias-border-l3);
}
.dshTwFrame[data-sidebar-collapsed]:not([data-sidebar-drawer]) .dshTwSidebarCol { border-right: none; }

.dshTwMarketCol, .dshTwMainCol {
  grid-row: 2;
  position: relative;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--dsw-alias-bg-base);
}
.dshTwMarketCol { grid-column: 3; }
.dshTwMainCol { grid-column: 4; }
.dshTwMarketCol:not([data-tw-hidden]) ~ .dshTwMainCol { border-left: 0.5px solid var(--dsw-alias-border-l3); }
.dshTwMainPanel { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }

/* The right column never clips: its occupant anchors its panel to the frame's right edge. */
.dshTwRightbarCol { grid-row: 2; grid-column: 5; position: relative; min-width: 0; overflow: visible; }

.dshTwFrame [data-tw-hidden] { display: none !important; }

.dshTwBottomRow { grid-row: 3; grid-column: 1 / -1; min-width: 0; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-base); }
.dshTwOverlayLayer { position: absolute; inset: 0; z-index: 20; pointer-events: none; }
.dshTwOverlayLayer > * { pointer-events: auto; }

/* Reopen and New Session controls of a hidden session list, centred on the Conversation title row. */
.dshTwLeadingSeat { position: absolute; top: 11px; left: 12px; z-index: 15; display: flex; align-items: center; -webkit-app-region: no-drag; }

/* An 8px hit strip on a column border, confined to the column row. */
.dshTwHandle {
  position: absolute;
  grid-area: 2 / 1 / 3 / -1;
  top: 0;
  bottom: 0;
  width: 8px;
  margin-left: -4px;
  cursor: col-resize;
  z-index: 11;
  touch-action: none;
}
.dshTwHandle::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 3px;
  width: 2px;
  background: var(--dsw-alias-brand-primary, #3b82f6);
  opacity: 0;
  transition: opacity 120ms ease;
}
.dshTwHandle:hover::after { opacity: 0.45; transition-delay: 150ms; }
.dshTwHandle[data-dragging]::after { opacity: 0.7; transition-delay: 0ms; }
.dshTwFrame[data-dragging] { cursor: col-resize; user-select: none; }
.dshTwFrame[data-dragging] iframe { pointer-events: none; }

/* Narrow frames: the session list overlays the content beside the activity bar. */
.dshTwFrame[data-sidebar-drawer] { --dsh-frame-leading-clearance: ${84}px; overflow: clip; }
.dshTwFrame[data-sidebar-drawer] .dshTwSidebarCol {
  position: absolute;
  grid-area: 2 / 1 / 3 / -1;
  inset: 0 auto 0 48px;
  z-index: 71;
  box-sizing: border-box;
  border-right: 0.5px solid var(--dsw-alias-border-l3);
  transform: translateX(0);
  visibility: visible;
  transition: transform var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, ease);
}
.dshTwFrame[data-sidebar-drawer][data-sidebar-collapsed] .dshTwSidebarCol {
  transform: translateX(calc(-100% - 48px));
  visibility: hidden;
  transition: transform var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, ease), visibility 0s linear var(--ds-transition-duration-slow, 300ms);
}
.dshTwDrawerMask {
  position: absolute;
  grid-area: 2 / 1 / 3 / -1;
  inset: 0;
  z-index: 70;
  background: var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 30%));
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--ds-transition-duration-slow, 300ms) var(--ds-ease-in-out, ease);
}
.dshTwFrame[data-sidebar-drawer]:not([data-sidebar-collapsed]) .dshTwDrawerMask { opacity: 1; pointer-events: auto; }
@media (prefers-reduced-motion: reduce) {
  .dshTwFrame[data-sidebar-drawer] .dshTwSidebarCol, .dshTwDrawerMask { transition: none; }
}
`

/**
 * Install the frame styles.
 * @returns the removal function.
 */
export function installTradingShellStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-desktop-next/trading-shell'
  style.textContent = STYLES
  document.head.append(style)
  return () => style.remove()
}
