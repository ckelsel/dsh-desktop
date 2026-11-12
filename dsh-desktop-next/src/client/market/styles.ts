/**
 * Market page styles, injected as a style element: the client build scopes imported `.css` files to
 * the onboarding surface. Surfaces use the app's theme tokens; price colours are TradingView's
 * defaults, and `--mk-up` and `--mk-down` follow the page's price colour setting. Layers the page
 * portals to `document.body` carry `dshMkLayer` for the same tokens.
 */
const STYLES = `
.dshMkPage, .dshMkLayer {
  /* TradingView's default candle colours, shared by the chart and the page. */
  --mk-green: #089981;
  --mk-red: #f23645;
  --mk-up: var(--mk-green);
  --mk-down: var(--mk-red);
  --mk-buy: #2962ff;
  --mk-sell: var(--mk-red);
  --mk-accent: var(--dsw-static-blue-500, #3b82f6);
  --mk-bg: var(--dsw-alias-bg-base);
  --mk-raised: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));
  --mk-input: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, var(--dsw-alias-bg-base));
  --mk-text: var(--dsw-alias-label-primary);
  --mk-text-2: var(--dsw-alias-label-secondary);
  --mk-text-3: var(--dsw-alias-label-tertiary);
  --mk-line: var(--dsw-alias-border-l2);
  --mk-line-soft: var(--dsw-alias-border-l1);
  --mk-hover: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  --mk-pressed: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
  --mk-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
  --mk-warn-text: var(--dsw-alias-state-warn-label, #b45309);
  --mk-error: var(--dsw-alias-state-error-primary, #ef4444);
}
.dshMkPage {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--mk-bg);
  color: var(--mk-text);
  font-size: 12px;
  line-height: 1.4;
  container: dsh-market / inline-size;
}
.dshMkPage[data-up='red'], .dshMkLayer [data-up='red'] { --mk-up: var(--mk-red); --mk-down: var(--mk-green); }
.dshMkPage[data-dragging] { user-select: none; }
.dshMkPage[data-dragging] iframe { pointer-events: none; }
.dshMkPage :focus-visible { outline: 2px solid var(--mk-accent); outline-offset: -2px; }
.dshMkPage button { font: inherit; }
.dshMkPage [data-trend='up'], .dshMkLayer [data-trend='up'] { color: var(--mk-up); }
.dshMkPage [data-trend='down'], .dshMkLayer [data-trend='down'] { color: var(--mk-down); }
.dshMkMuted { color: var(--mk-text-3); }
.dshMkNum { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshMkEmpty { padding: 16px; text-align: center; color: var(--mk-text-3); }
.dshMkEmpty[data-table] { padding: 32px 16px; }

/* Layout: chart over the trading panel | side panel | icon strip. */
.dshMkMain { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.dshMkChartArea { position: relative; flex: 1 1 auto; min-height: 120px; }
.dshMkBottom { flex: 0 0 auto; min-height: 0; display: flex; flex-direction: column; border-top: 0.5px solid var(--mk-line); background: var(--mk-bg); }
.dshMkSidePanel {
  flex: 0 0 var(--mk-panel-width);
  width: var(--mk-panel-width);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 0.5px solid var(--mk-line);
  background: var(--mk-bg);
}
.dshMkStrip {
  flex: 0 0 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  border-left: 0.5px solid var(--mk-line);
  background: var(--mk-bg);
}
.dshMkStripSpacer { flex: 1 1 auto; }
.dshMkStripButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--mk-text-3);
  cursor: pointer;
}
.dshMkStripButton:hover { color: var(--mk-text); background: var(--mk-hover); }
.dshMkStripButton[aria-pressed='true'] { color: var(--mk-accent); background: color-mix(in srgb, var(--mk-accent) 12%, transparent); }

.dshMkSplitter { position: relative; flex: 0 0 0px; z-index: 4; }
.dshMkSplitter::before { content: ''; position: absolute; }
.dshMkSplitter[data-axis='column']::before { top: 0; bottom: 0; left: -4px; width: 8px; cursor: col-resize; }
.dshMkSplitter[data-axis='row']::before { left: 0; right: 0; top: -4px; height: 8px; cursor: row-resize; }
.dshMkSplitter::after { content: ''; position: absolute; background: var(--mk-accent); opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
.dshMkSplitter[data-axis='column']::after { top: 0; bottom: 0; left: -1px; width: 2px; }
.dshMkSplitter[data-axis='row']::after { left: 0; right: 0; top: -1px; height: 2px; }
.dshMkSplitter:hover::after { opacity: 0.45; transition-delay: 150ms; }
.dshMkSplitter[data-dragging]::after, .dshMkSplitter:focus-visible::after { opacity: 0.8; transition-delay: 0ms; }
.dshMkSplitter:focus-visible { outline: none; }
.dshMkPage[data-dragging] { cursor: grabbing; }

/* Chart. */
.dshMkChart, .dshMkChartWidget { position: absolute; inset: 0; }
.dshMkChartWidget[data-hidden] { visibility: hidden; }
.dshMkChartState {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--mk-text-3);
}
.dshMkChartState strong { color: var(--mk-text); font-size: 14px; font-weight: 600; }
/* Waiting for MT5: shown after a moment, so a quick start does not flash it. */
.dshMkWaiting {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: var(--mk-text-3);
  animation: dshMkFadeIn 160ms ease 400ms both;
}
.dshMkWaiting strong { color: var(--mk-text); font-size: 14px; font-weight: 600; }
.dshMkWaiting > span { max-width: 420px; line-height: 1.5; }
.dshMkWaiting[data-compact] { position: static; justify-content: flex-start; padding: 32px 16px; }
@keyframes dshMkFadeIn { from { opacity: 0; } to { opacity: 1; } }
.dshMkButton {
  height: 28px;
  padding: 0 14px;
  border: 0.5px solid var(--mk-line);
  border-radius: 6px;
  background: var(--mk-raised);
  color: var(--mk-text);
  cursor: pointer;
}
.dshMkButton:hover:not(:disabled) { background: var(--mk-hover); }
.dshMkButton:disabled { opacity: 0.5; cursor: default; }

.dshMkNotices {
  position: absolute;
  top: 46px;
  left: 50%;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: calc(100% - 32px);
  transform: translateX(-50%);
  pointer-events: none;
}
.dshMkNotice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 6px 7px 12px;
  border: 0.5px solid var(--mk-line);
  border-left: 3px solid var(--mk-accent);
  border-radius: 8px;
  background: var(--dsw-specific-menu, var(--mk-raised));
  box-shadow: 0 6px 20px rgb(0 0 0 / 16%);
  color: var(--mk-text);
  font-size: 13px;
  pointer-events: auto;
  backdrop-filter: blur(12px);
}
.dshMkNotice[data-tone='success'] { border-left-color: var(--mk-green); }
.dshMkNotice[data-tone='warning'] { border-left-color: var(--dsw-alias-state-warn-primary, #f59e0b); }
.dshMkNotice[data-tone='error'] { border-left-color: var(--dsw-alias-state-error-primary, #ef4444); }

/* Panels. */
.dshMkPanel { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; min-width: 0; }
.dshMkPanelHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 40px;
  padding: 0 8px 0 12px;
  border-bottom: 0.5px solid var(--mk-line-soft);
  min-width: 0;
}
.dshMkPanelHeader h2 { flex: 1 1 auto; margin: 0; font-size: 13px; font-weight: 600; white-space: nowrap; }
.dshMkIconButton {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mk-text-2);
  cursor: pointer;
}
.dshMkIconButton:hover:not(:disabled) { color: var(--mk-text); background: var(--mk-hover); }
.dshMkIconButton[aria-pressed='true'] { color: var(--mk-text); background: var(--mk-pressed); }
.dshMkIconButton:disabled { opacity: 0.4; cursor: default; }
.dshMkTabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--mk-hover); }
.dshMkTab {
  display: inline-flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mk-text-2);
  white-space: nowrap;
  cursor: pointer;
}
.dshMkTab:hover { color: var(--mk-text); }
.dshMkTab[aria-selected='true'], .dshMkTab[aria-checked='true'] { color: var(--mk-text); background: var(--mk-raised); box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }
.dshMkSearch {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 2px 0 8px;
  border: 0.5px solid var(--mk-line);
  border-radius: 6px;
  background: var(--mk-input);
  color: var(--mk-text-3);
}
.dshMkSearch:focus-within { border-color: var(--mk-accent); }
.dshMkSearch input { flex: 1 1 auto; min-width: 0; border: 0; outline: none; background: transparent; color: var(--mk-text); font: inherit; font-size: 13px; }

/* Watchlist. */
.dshMkWlTable { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 96px; }
.dshMkWlGrid {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 0.85fr) minmax(0, 0.8fr);
  align-items: center;
  column-gap: 6px;
  padding: 0 10px 0 12px;
}
.dshMkWlHead { flex: 0 0 28px; color: var(--mk-text-3); border-bottom: 0.5px solid var(--mk-line-soft); }
.dshMkWlHeadCell {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
}
.dshMkWlHeadCell[data-numeric] { justify-content: flex-end; }
.dshMkWlHeadCell:hover, .dshMkWlHeadCell[aria-sort='ascending'], .dshMkWlHeadCell[aria-sort='descending'] { color: var(--mk-text); }
.dshMkWlBody { flex: 1 1 auto; min-height: 0; overflow: auto; padding-bottom: 6px; }
.dshMkWlGroup {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 28px;
  padding: 0 12px 0 8px;
  border: 0;
  background: transparent;
  color: var(--mk-text-2);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.dshMkWlGroup:hover { color: var(--mk-text); }
.dshMkWlRow { position: relative; height: 32px; font-size: 13px; cursor: pointer; }
.dshMkWlRow:hover { background: var(--mk-hover); }
.dshMkWlRow[data-active] { background: color-mix(in srgb, var(--mk-accent) 12%, transparent); }
.dshMkWlRow:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--mk-accent); }
.dshMkWlRow[data-closed] .dshMkFlash { color: var(--mk-text-3); }
.dshMkWlSymbol { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dshMkWlBadge {
  display: inline-flex;
  flex: 0 0 18px;
  align-items: center;
  justify-content: center;
  height: 18px;
  border-radius: 50%;
  background: var(--mk-accent);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}
.dshMkWlBadge[data-asset='metal'] { background: #c9961a; }
.dshMkWlBadge[data-asset='index'] { background: #7e57c2; }
.dshMkWlBadge[data-asset='commodity'] { background: #8d6e63; }
.dshMkWlBadge[data-asset='crypto'] { background: #f7931a; }
.dshMkWlBadge[data-asset='stock'] { background: #26a69a; }
.dshMkWlBadge[data-asset='other'] { background: #78909c; }
.dshMkWlPaused { flex: 0 0 auto; padding: 6px 10px; border-bottom: 0.5px solid var(--mk-line-soft); background: color-mix(in srgb, var(--mk-warn) 12%, transparent); color: var(--mk-warn-text); font-size: 11px; line-height: 1.4; }
.dshMkWlTicker { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.dshMkFlash { display: inline-block; margin-right: -3px; padding: 1px 3px; border-radius: 3px; }
.dshMkFlash[data-flash='up'] { animation: dshMkFlashUp 900ms ease-out; }
.dshMkFlash[data-flash='down'] { animation: dshMkFlashDown 900ms ease-out; }
@keyframes dshMkFlashUp { from { color: var(--mk-up); background: color-mix(in srgb, var(--mk-up) 24%, transparent); } to { background: transparent; } }
@keyframes dshMkFlashDown { from { color: var(--mk-down); background: color-mix(in srgb, var(--mk-down) 24%, transparent); } to { background: transparent; } }
@media (prefers-reduced-motion: reduce) { .dshMkFlash[data-flash] { animation: none; } }
.dshMkWlRemove {
  position: absolute;
  top: 50%;
  right: 4px;
  display: none;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: var(--mk-raised);
  color: var(--mk-text-2);
  transform: translateY(-50%);
  cursor: pointer;
}
.dshMkWlRow:hover .dshMkWlRemove, .dshMkWlRow:focus-within .dshMkWlRemove { display: inline-flex; }
.dshMkWlRemove:hover { color: var(--mk-text); }
.dshMkWlAdd { display: flex; flex: 0 0 auto; flex-direction: column; gap: 6px; padding: 8px; border-bottom: 0.5px solid var(--mk-line-soft); }
.dshMkWlAddList { display: flex; flex-direction: column; max-height: 220px; overflow: auto; }
.dshMkWlAddItem {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mk-text);
  text-align: left;
  cursor: pointer;
}
.dshMkWlAddItem > .dshMkMuted { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshMkWlAddItem:hover { background: var(--mk-hover); }

/* Symbol details. */
.dshMkDetails {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  gap: 10px;
  max-height: 62%;
  padding: 12px;
  overflow: auto;
  border-top: 0.5px solid var(--mk-line);
}
.dshMkDetailsHead { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.dshMkDetailsTicker { font-size: 15px; font-weight: 700; }
.dshMkStatus { flex: 0 0 auto; padding: 2px 8px; border-radius: 999px; background: var(--mk-pressed); color: var(--mk-text-2); font-size: 11px; white-space: nowrap; }
.dshMkStatus::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; }
.dshMkStatus[data-open] { color: var(--mk-green); background: color-mix(in srgb, var(--mk-green) 14%, transparent); }
.dshMkDetailsPrice { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.dshMkDetailsLast { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dshMkQuoteBox { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; padding: 8px 10px; border-radius: 8px; background: var(--mk-hover); }
.dshMkQuoteBox > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 11px; }
.dshMkQuoteBox > div[data-center] { align-items: center; }
.dshMkQuoteBox > div[data-end] { align-items: flex-end; }
.dshMkQuoteBox strong { font-size: 13px; font-variant-numeric: tabular-nums; }
.dshMkQuoteBox [data-side='sell'] { color: var(--mk-sell); }
.dshMkQuoteBox [data-side='buy'] { color: var(--mk-buy); }
.dshMkRange { display: flex; flex-direction: column; gap: 6px; }
.dshMkRangeLabels { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; font-variant-numeric: tabular-nums; }
.dshMkRangeTrack { position: relative; height: 4px; border-radius: 2px; background: linear-gradient(90deg, var(--mk-down), var(--mk-up)); }
.dshMkRangeMarker { position: absolute; top: 50%; width: 8px; height: 8px; border: 2px solid var(--mk-text); border-radius: 50%; background: var(--mk-bg); transform: translate(-50%, -50%); }
.dshMkStats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; margin: 0; }
.dshMkStats[data-wide] { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.dshMkStats > div { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dshMkStats dt { color: var(--mk-text-3); font-size: 11px; }
.dshMkStats dd { margin: 0; overflow: hidden; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
.dshMkSession { display: flex; flex-direction: column; gap: 2px; color: var(--mk-text-2); font-size: 11px; }

/* Order ticket. */
.dshMkTicketSymbol { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; white-space: nowrap; }
.dshMkTicketSymbol .dshMkMuted { overflow: hidden; text-overflow: ellipsis; }
.dshMkTicketBody { display: flex; flex: 1 1 auto; flex-direction: column; gap: 12px; min-height: 0; padding: 12px; overflow: auto; }
.dshMkTicket .dshMkTabs { display: flex; }
.dshMkSides { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.dshMkSide {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--mk-line);
  border-radius: 8px;
  background: transparent;
  color: var(--mk-text);
  cursor: pointer;
}
.dshMkSide[data-side='buy'] { align-items: flex-end; }
.dshMkSide span { color: var(--mk-text-2); font-size: 11px; }
.dshMkSide strong { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dshMkSide[data-side='sell'] strong { color: var(--mk-sell); }
.dshMkSide[data-side='buy'] strong { color: var(--mk-buy); }
.dshMkSide[data-side='sell']:hover { border-color: var(--mk-sell); }
.dshMkSide[data-side='buy']:hover { border-color: var(--mk-buy); }
.dshMkSide[data-side='sell'][aria-checked='true'] { border-color: var(--mk-sell); background: var(--mk-sell); }
.dshMkSide[data-side='buy'][aria-checked='true'] { border-color: var(--mk-buy); background: var(--mk-buy); }
.dshMkSide[aria-checked='true'] span, .dshMkSide[aria-checked='true'] strong { color: #fff; }
.dshMkSpread {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  min-width: 30px;
  padding: 1px 6px;
  border: 0.5px solid var(--mk-line);
  border-radius: 4px;
  background: var(--mk-bg);
  color: var(--mk-text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.dshMkField { display: flex; flex-direction: column; gap: 6px; }
.dshMkField > label { color: var(--mk-text-2); font-size: 11px; }
.dshMkFieldInfo { min-height: 15px; color: var(--mk-text-3); font-size: 11px; }
.dshMkStepper {
  display: flex;
  align-items: stretch;
  height: 32px;
  overflow: hidden;
  border: 0.5px solid var(--mk-line);
  border-radius: 6px;
  background: var(--mk-input);
}
.dshMkStepper:focus-within { border-color: var(--mk-accent); box-shadow: 0 0 0 1px var(--mk-accent); }
.dshMkStepper[data-disabled] { opacity: 0.5; }
.dshMkStepper input {
  flex: 1 1 auto;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--mk-text);
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.dshMkStepButton {
  display: inline-flex;
  flex: 0 0 30px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--mk-text-2);
  cursor: pointer;
}
.dshMkStepButton:hover:not(:disabled) { color: var(--mk-text); background: var(--mk-hover); }
.dshMkStepButton:disabled { cursor: default; }
.dshMkPresets { display: flex; gap: 4px; }
.dshMkChip {
  flex: 1 1 0;
  height: 24px;
  border: 0.5px solid var(--mk-line);
  border-radius: 6px;
  background: transparent;
  color: var(--mk-text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.dshMkChip:hover { color: var(--mk-text); background: var(--mk-hover); }
.dshMkChip[aria-pressed='true'] { border-color: var(--mk-accent); color: var(--mk-accent); }
.dshMkBracket { display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: center; gap: 6px 8px; }
.dshMkBracketInfo { display: flex; grid-column: 2; justify-content: space-between; gap: 8px; color: var(--mk-text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.dshMkCheck { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.dshMkCheck input { margin: 0; accent-color: var(--mk-accent); }
.dshMkSummary { display: flex; flex-direction: column; gap: 5px; margin: 0; padding-top: 10px; border-top: 0.5px solid var(--mk-line-soft); }
.dshMkSummary > div { display: flex; justify-content: space-between; gap: 8px; }
.dshMkSummary dt { color: var(--mk-text-2); }
.dshMkSummary dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
.dshMkMessage { margin: 0; padding: 6px 8px; border-radius: 6px; font-size: 12px; }
.dshMkMessage[data-tone='error'] { color: var(--dsw-alias-state-error-primary, #ef4444); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 10%, transparent); }
.dshMkMessage[data-tone='warning'] { color: var(--dsw-alias-state-warn-label, #b45309); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 14%, transparent); }
.dshMkSubmit {
  flex: 0 0 auto;
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: 8px;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.dshMkSubmit[data-side='buy'] { background: var(--mk-buy); }
.dshMkSubmit[data-side='sell'] { background: var(--mk-sell); }
.dshMkSubmit:hover:not(:disabled) { filter: brightness(1.08); }
.dshMkSubmit:disabled { opacity: 0.45; cursor: default; }
.dshMkHint { margin: 0; color: var(--mk-text-3); font-size: 11px; text-align: center; }
/* The account's type beside the submit button; a real-money account stands out. */
.dshMkSubmitRow { display: flex; align-items: stretch; gap: 6px; }
.dshMkSubmitRow > .dshMkSubmit { flex: 1 1 auto; min-width: 0; }
.dshMkAccountTag {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  padding: 0 8px;
  border: 0.5px solid var(--mk-line);
  border-radius: 8px;
  color: var(--mk-text-2);
  font-size: 12px;
  font-weight: 600;
}
.dshMkAccountTag[data-mode='real'] { border-color: var(--mk-error); color: #fff; background: var(--mk-error); }
.dshMkHint .dshMkTextButton { margin-left: 4px; }

/* Trading panel. */
.dshMkTrade { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; container: dsh-trade / inline-size; }
.dshMkTradeBar { display: flex; flex: 0 0 36px; align-items: center; gap: 8px; min-width: 0; padding: 0 6px 0 4px; }
.dshMkTrade[data-open] .dshMkTradeBar { border-bottom: 0.5px solid var(--mk-line-soft); }
.dshMkTradeTabs { display: flex; flex: 0 1 auto; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.dshMkTradeSpacer { flex: 1 1 auto; }
.dshMkTradeTab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mk-text-2);
  white-space: nowrap;
  cursor: pointer;
}
.dshMkTradeTab:hover { color: var(--mk-text); background: var(--mk-hover); }
.dshMkTradeTab[aria-selected='true'] { color: var(--mk-text); font-weight: 600; }
.dshMkTradeTab[aria-selected='true']::after { content: ''; position: absolute; right: 10px; bottom: -4px; left: 10px; height: 2px; border-radius: 1px; background: var(--mk-accent); }
.dshMkCount {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 8px;
  background: var(--mk-pressed);
  font-size: 10px;
  font-weight: 600;
}
.dshMkAccountSummary { display: flex; align-items: center; gap: 4px 16px; min-width: 0; white-space: nowrap; }
.dshMkAccountSummary[data-compact] { flex: 0 1 auto; overflow: hidden; }
.dshMkAccountSummary:not([data-compact]) { flex: 0 0 auto; flex-wrap: wrap; padding: 6px 12px; border-bottom: 0.5px solid var(--mk-line-soft); }
@container dsh-trade (max-width: 760px) { .dshMkAccountSummary[data-compact] { display: none; } }
.dshMkSummaryItem { display: inline-flex; align-items: baseline; gap: 5px; }

/* Connection badge and its details, which float from document.body. */
.dshMkConn { display: inline-flex; flex: 0 0 auto; }
.dshMkConnBadge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 8px;
  border: 0;
  border-radius: 999px;
  background: var(--mk-pressed);
  color: var(--mk-text-2);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}
.dshMkConnBadge[data-static] { cursor: default; }
.dshMkConnBadge::before { content: ''; flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dshMkConnBadge:not([data-static]):hover { box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 40%, transparent); }
.dshMkConnBadge[data-tone='mock'], .dshMkConnBadge[data-tone='warning'] { color: var(--mk-warn-text); background: color-mix(in srgb, var(--mk-warn) 16%, transparent); }
.dshMkConnBadge[data-tone='ok'] { color: var(--mk-green); background: color-mix(in srgb, var(--mk-green) 14%, transparent); }
.dshMkConnBadge[data-tone='error'] { color: var(--mk-error); background: color-mix(in srgb, var(--mk-error) 12%, transparent); }
.dshMkConnBadge[data-tone='busy']::before { animation: dshMkPulse 1.2s ease-in-out infinite; }
@keyframes dshMkPulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .dshMkConnBadge[data-tone='busy']::before { animation: none; } }
.dshMkLayer { color: var(--mk-text); font-size: 12px; line-height: 1.45; }
.dshMkLayer button { font: inherit; }
.dshMkLayer :focus-visible { outline: 2px solid var(--mk-accent); outline-offset: 1px; }
.dshMkConnPanel {
  position: fixed;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-sizing: border-box;
  width: 320px;
  max-width: var(--dsh-anchored-max-width, calc(100vw - 16px));
  max-height: var(--dsh-anchored-max-height, calc(100vh - 16px));
  overflow: auto;
  padding: 12px 14px;
  border: 0.5px solid var(--mk-line);
  box-shadow: 0 8px 28px rgb(0 0 0 / 18%);
}
.dshMkConnHeader { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dshMkConnPanel h3 { margin: 0; font-size: 13px; font-weight: 600; }
.dshMkConnPanel h4 { margin: 0 0 4px; color: var(--mk-text-3); font-size: 11px; font-weight: 600; }
.dshMkConnPanel p { margin: 0; color: var(--mk-text-2); }
.dshMkConnPanel [data-tone='ok'] { color: var(--mk-green); }
.dshMkConnPanel [data-tone='warning'] { color: var(--mk-warn-text); }
.dshMkConnPanel [data-tone='error'] { color: var(--mk-error); }
.dshMkConnHint { font-size: 11px; }
.dshMkConnRows { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 0; }
.dshMkConnRows > div { display: contents; }
.dshMkConnRows dt { color: var(--mk-text-3); white-space: nowrap; }
.dshMkConnRows dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.dshMkConnTrading ul { margin: 0; padding-left: 16px; color: var(--mk-warn-text); }
.dshMkConnActions { display: flex; justify-content: flex-end; }
.dshMkTradeBody { flex: 1 1 auto; min-height: 0; overflow: auto; }
.dshMkHistoryBody { display: flex; flex-direction: column; min-height: 100%; }
.dshMkHistoryBar { position: sticky; left: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 10px; border-bottom: 0.5px solid var(--mk-line-soft); }
.dshMkHistoryBar .dshMkTabs { flex: 0 0 auto; }
.dshMkHistoryBar .dshMkTab { flex: 0 0 auto; height: 22px; padding: 0 8px; font-size: 12px; }
.dshMkDateRange { display: inline-flex; align-items: center; gap: 6px; color: var(--mk-text-3); font-size: 12px; }
.dshMkDateInput {
  height: 24px;
  padding: 0 6px;
  box-sizing: border-box;
  border: 0.5px solid var(--mk-line);
  border-radius: 4px;
  background: var(--mk-input);
  color: var(--mk-text);
  font: inherit;
  color-scheme: light dark;
}
.dshMkHistoryStatus { display: inline-flex; align-items: center; gap: 8px; color: var(--mk-text-3); font-size: 12px; }
.dshMkHistoryStatus[data-tone='error'] { color: var(--mk-error); }
.dshMkHistoryStatus[data-tone='warning'] { color: var(--mk-warn-text); }
.dshMkTable tfoot td { position: sticky; bottom: 0; height: 30px; border-top: 0.5px solid var(--mk-line); border-bottom: 0; background: var(--mk-bg); font-weight: 600; }
.dshMkTable tr[data-kind='balance'] td { color: var(--mk-text-2); }
.dshMkTable { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dshMkTable th {
  position: sticky;
  top: 0;
  z-index: 1;
  height: 28px;
  padding: 0 10px;
  border-bottom: 0.5px solid var(--mk-line-soft);
  background: var(--mk-bg);
  color: var(--mk-text-3);
  font-weight: 500;
  text-align: left;
}
.dshMkTable td { height: 30px; padding: 0 10px; border-bottom: 0.5px solid var(--mk-line-soft); }
.dshMkTable [data-numeric] { text-align: right; }
.dshMkTable tbody tr { cursor: pointer; }
.dshMkTable tbody tr:hover { background: var(--mk-hover); }
.dshMkTable [data-side='buy'] { color: var(--mk-buy); }
.dshMkTable [data-side='sell'] { color: var(--mk-sell); }
.dshMkCellInput {
  width: 88px;
  height: 22px;
  padding: 0 6px;
  box-sizing: border-box;
  border: 0.5px solid var(--mk-accent);
  border-radius: 4px;
  outline: none;
  background: var(--mk-input);
  color: var(--mk-text);
  font: inherit;
  text-align: right;
}
.dshMkCellInput[aria-invalid] { border-color: var(--mk-error); }
.dshMkRowActions { display: inline-flex; align-items: center; gap: 4px; }
.dshMkSelect {
  height: 22px;
  padding: 0 6px;
  border: 0.5px solid var(--mk-line);
  border-radius: 4px;
  background: var(--mk-bg);
  color: var(--mk-text);
  font: inherit;
  font-size: 11px;
}
/* Closing several positions. */
.dshMkCloseDialog[role="dialog"] { width: min(640px, calc(100vw - 48px)); }
.dshMkCloseIntro { margin: 0 0 8px; font-size: 13px; }
.dshMkCloseList { max-height: min(48dvh, 400px); overflow-y: auto; overscroll-behavior: contain; }
.dshMkCloseList .dshMkTable { width: 100%; }
.dshMkCloseList .dshMkTable tbody tr { cursor: default; }
.dshMkCloseTotal { display: flex; justify-content: space-between; margin: 8px 0; font-size: 13px; font-variant-numeric: tabular-nums; }
.dshMkCloseState[data-state='waiting'], .dshMkCloseState[data-state='skipped'] { color: var(--mk-text-3); }
.dshMkCloseState[data-state='done'] { color: var(--mk-green); }
.dshMkCloseState[data-state='failed'] { color: var(--mk-error); }
.dshMkCloseState[data-state='unconfirmed'] { color: var(--mk-warn-text); }
.dshMkTextButton {
  height: 22px;
  padding: 0 8px;
  border: 0.5px solid var(--mk-line);
  border-radius: 4px;
  background: transparent;
  color: var(--mk-text);
  font-size: 11px;
  cursor: pointer;
}
.dshMkTextButton:hover:not(:disabled) { background: var(--mk-hover); }
.dshMkTextButton:disabled { opacity: 0.5; cursor: default; }
.dshMkState[data-state='cancelled'], .dshMkState[data-state='expired'], .dshMkState[data-state='placed'] { color: var(--mk-text-3); }
.dshMkState[data-state='partial'] { color: var(--mk-warn-text); }
.dshMkState[data-state='rejected'] { color: var(--dsw-alias-state-error-primary, #ef4444); }
.dshMkAccountTab { display: grid; grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr); gap: 24px; padding: 12px 16px; }
.dshMkAccountTab h3 { margin: 0 0 10px; color: var(--mk-text-2); font-size: 12px; font-weight: 600; }
.dshMkSetting { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.dshMkSwatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; background: linear-gradient(135deg, var(--mk-green) 50%, var(--mk-red) 50%); }
.dshMkSwatch[data-color='red'] { background: linear-gradient(135deg, var(--mk-red) 50%, var(--mk-green) 50%); }

/* Narrow pages: the side panel floats over the chart. */
@container dsh-market (max-width: 760px) {
  .dshMkSidePanel {
    position: absolute;
    top: 0;
    right: 44px;
    bottom: 0;
    z-index: 8;
    width: min(var(--mk-panel-width), calc(100cqw - 60px));
    box-shadow: -8px 0 24px rgb(0 0 0 / 18%);
  }
  .dshMkPage > .dshMkSplitter { display: none; }
  .dshMkAccountTab { grid-template-columns: minmax(0, 1fr); }
}
`

/**
 * Install the market page styles.
 * @returns the removal function.
 */
export function installMarketStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-desktop-next/market'
  style.textContent = STYLES
  document.head.append(style)
  return () => style.remove()
}
