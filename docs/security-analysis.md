# Security Analysis

## Implemented Controls

- `minAmountOut` prevents execution when a swap returns less than the user accepts.
- `deadline` prevents old signed transactions from being mined unexpectedly later.
- SafeERC20 wrappers support ERC-20 tokens with non-standard return behavior.
- The contract uses Solidity 0.8 checked arithmetic.
- Swap output is capped by actual reserves, so virtual reserves cannot create withdrawable tokens.
- Virtual reserve updates are restricted to the contract owner for the MVP.
- Dust-sized swaps are rejected when integer rounding would return zero output.

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
