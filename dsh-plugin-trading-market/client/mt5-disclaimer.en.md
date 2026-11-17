<!--
The trading risk disclaimer, in English. This English version is authoritative if
it differs from mt5-disclaimer.zh.md. Keep both versions aligned in section and
bullet structure. After any substantive change, increment MT5_DISCLAIMER_VERSION
in src/mt5/contract.ts so existing users must acknowledge the updated text.
-->

# Trading Risk Warning and Disclaimer

This disclaimer is available in English and Chinese. You can switch languages in this dialog to read either version. If the versions differ, the English version prevails.

Read this warning carefully before trading. By checking the box and clicking "Agree and enable trading", you acknowledge the risks described below and agree to enable this software's trading functions, subject to account and system permissions.

## 1. Trading involves substantial risk.

- Forex, precious metals, indices, commodities, shares, CFDs, cryptocurrencies and other instruments available through MT5 may involve leverage and substantial risk. Prices can move or gap sharply, causing rapid losses.
- Many retail traders lose money when trading leveraged products.
- You may lose all the money in your trading account. Depending on the product, broker and applicable negative balance protection, you may owe more than the funds in your account.
- Trade only with money you can afford to lose, and understand the risks of the products and leverage you use.
- Past performance, backtests and demo-account results are not reliable indicators of future results or real-account execution.

## 2. What this software does and does not do.

- This software is an interface to your MetaTrader 5 (MT5) terminal through the DshBridge Expert Advisor (EA). It is not a broker and does not itself hold or custody your funds.
- The developers are not acting as your investment adviser, financial institution or broker through this software. The software does not provide personalized investment, financial, tax or legal advice.
- Charts, indicators, trading information and AI-generated content are not guarantees or personalized recommendations to buy or sell. AI-generated content may be inaccurate, incomplete or misleading; verify it independently before acting.
- This software does not verify whether your broker is properly regulated or suitable for you. You are responsible for evaluating your broker and its terms.

## 3. Trade execution and account records depend on MT5 and your broker.

- Trading requests are sent through your MT5 terminal to your broker. A request being sent or acknowledged does not necessarily mean that an order has been filled.
- Execution prices, slippage, rejections, partial fills, order status, margin, stop-outs, commissions and swaps depend on your broker and market conditions. Confirm actual results against MT5 and your broker's records.
- Quotes, charts, profit and loss, margin figures and pip or point values shown by this software may come from MT5, the broker or third-party chart components. They may be delayed, missing or different from the broker's execution data; their accuracy, completeness and timeliness are not guaranteed.

## 4. Trading depends on the terminal, the EA and their connections.

- Trading through this software requires MT5 to be running and logged in, DshBridge EA to be running with the necessary trading permissions, a working connection between the two applications and permission to trade from your broker. A remote MT5 installation also depends on the network between the computers.
- If a dependency fails, this software may be unable to submit or manage trades, and displayed account information may become outdated. Orders already submitted and server-side instructions may still execute.
- Stop Loss and Take Profit instructions accepted by the broker are generally handled on the broker's server, but they do not guarantee execution at the specified price. Trailing stops and other client-side automation may stop working if MT5 or the relevant EA stops running.
- Device failures, MT5 or EA faults, network interruptions and broker outages may prevent requests from reaching the broker, delay execution or leave an order's outcome temporarily unknown. An order may execute even when this software does not receive confirmation.
- If a trade's outcome is unknown, this software does not automatically resend that request. Check open orders, positions and trading history in MT5 or with your broker before submitting another instruction; the broker's execution records govern the actual account state.

## 5. Connection security has limits.

- The DshBridge connection is designed to use TLS encryption, token-based authentication and signed trading requests. These safeguards reduce risk but cannot guarantee security, and their effectiveness depends on correct implementation and configuration.
- Someone who obtains your connection token may be able to impersonate an authorized component. Keep the token secret; if it may have been exposed, regenerate it in Settings → MT5 connection, enter the new token in the DshBridge EA, and reconnect the EA.
- Connection credentials and request logs may be stored on computers running this software or MT5, including the MT5 data folder. Protect those files and any backups against unauthorized access.
- These safeguards cannot protect against every threat, especially if either computer is compromised or configured insecurely.

## 6. Real-money trading may be enabled after acceptance.

- Accepting this warning permits this software to request placing, closing, modifying and cancelling orders on demo, contest or real-money accounts, subject to the current account, broker and MT5 trading permissions. Acceptance alone does not place an order.
- Trades on a real-money account involve actual money and may result in real financial losses. A submitted trade may not be reversible.
- Before every trade, verify the account number and account type in the trading panel's Account tab, together with the symbol, direction, volume and any protective orders.

## 7. The software is provided as is; liability is limited where lawful.

- This software is provided "as is" and may contain defects, errors or vulnerabilities. Features and availability may change.
- Continuous availability, error-free operation, uninterrupted connectivity and complete or timely delivery of data or trade requests are not guaranteed.
- To the maximum extent permitted by applicable law, the developers disclaim liability for losses arising from use of, or inability to use, this software, including trading losses, lost profits, lost data, and losses caused by interruptions, delays or incorrect information.
- Nothing in this disclaimer excludes or limits liability or consumer rights that cannot lawfully be excluded or limited under applicable law.

## 8. You remain responsible for trading decisions and compliance.

- You decide whether to submit trading instructions through this software, and you are responsible for reviewing the account, order details and associated risks.
- You are responsible for assessing any AI-generated content or other information before relying on it. The software does not guarantee trading outcomes or protect you from losses.
- You must comply with the laws and regulations that apply to you, your account and the products you trade. Do not use this software for trading that is prohibited in your jurisdiction.

## 9. Updates and withdrawal of trading consent.

- If this disclaimer changes materially, the software requires you to read and accept the updated version before placing further trades through it.
- You can withdraw consent in Settings → MT5 connection. This disables new trading actions through this software but does not automatically cancel existing orders, close positions or prevent trading through MT5 or other devices. Market data may remain available if connected.

## 10. Language and interpretation.

- This disclaimer is available in English and Chinese. If the versions differ, the English version prevails.

---

I have read and understood this warning, acknowledge the risks of trading, and agree to enable trading functions through this software.
