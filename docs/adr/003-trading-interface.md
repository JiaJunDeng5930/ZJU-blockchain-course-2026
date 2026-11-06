# ADR 003: Put trading before development controls

Status: accepted

The previous layout treated every requirement as a permanent dashboard section. At a 581-pixel browser width the wallet and test balances consumed the whole first viewport, leaving the swap below the fold. Adding more instruction panels made that worse.

The interface now follows user tasks: Swap and Liquidity are the primary navigation. A compact wallet control opens a modal for connection, account selection, balances and test funding. Pools/tokens, arbitrage, simulation and current transaction activity live under Tools. Network details and developer commands do not occupy the main trading surface.

Swap owns its market selection, input/output assets, amount, quote, settings and execution action in one compact card. Liquidity opens on positions and exposes adding a position as a deliberate action rather than a permanent competing form. Both retain real chain quotes, the same contracts, wallet identity checks and transaction outcomes. Test funding is accessible on demand and never replaces the primary task.

Shared visual rules use a neutral light surface, blue action accent, compact typography, thin dividers and task-specific layouts. They intentionally avoid a repeated two-column card template. On narrow panes the primary action must remain in the first viewport; dialogs fit the viewport and keep their own scroll area.

This change preserves functionality while moving its entry points. Acceptance follows visible user flows rather than requiring test accounts or faucets to remain permanently expanded. Navigation retains its selected task in the URL so refresh and browser history have ordinary application behavior.

Navigation and wallet identity represent user choices that outlive a page render. A refresh preserves those choices; a locked browser wallet waits for recovery so that changing identity always follows an explicit user action. Decorative subheadings and repeated descriptions are omitted where the controls already explain the task.
