# Security Analysis

## Implemented Controls

| Risk | Mitigation | Remaining Limitation |
| --- | --- | --- |
| Slippage or sandwich-style adverse execution | `minAmountOut` rejects swaps below the user-selected minimum. | No private mempool or full MEV protection is implemented. |
| Stale transactions | `deadline` rejects old transactions. | Users still choose the deadline window. |
| Reentrancy during token transfers | Liquidity and swap state-changing functions use `ReentrancyGuard`. | This is not a substitute for a full audit. |
| Non-standard ERC-20 behavior | `SafeERC20` is used for token transfers. | Fee-on-transfer tokens are not explicitly supported. |
| Zero-output dust swaps | Quotes and swaps revert when integer rounding returns zero output. | Very small trades may fail instead of executing. |
| Virtual liquidity overreach | Owner updates are bounded by actual reserves. | Owner control is centralized in this MVP. |
| Imbalanced liquidity deposits | Follow-up liquidity must stay close to the current reserve ratio. | LPs must calculate the correct ratio after large swaps. |

## Risks and Limitations

- The AMM has no oracle, so its pool price can be manipulated by trades.
- The current dynamic fee rule is simple and should not be treated as optimal market design.
- There is no protocol fee recipient or governance process.
- The mock token has public minting because it is designed only for local demos.
- Liquidity providers still face impermanent loss.

## Future Hardening

- Add reentrancy protection around liquidity and swap flows.
- Replace owner-controlled virtual reserve updates with governance or immutable deployment parameters.
- Add TWAP oracle support.
- Add fuzz tests for reserve invariants.
- Perform gas snapshots and static analysis before any public deployment.
