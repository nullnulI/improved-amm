# Gas Optimization Notes

## Current Choices

- The Solidity optimizer is enabled with 200 runs.
- Reserves are stored directly instead of recomputing balances on every quote.
- Custom errors are used instead of long revert strings.
- Fee logic uses basis points to avoid floating-point math.

## Trade-Offs

- Keeping reserves in storage makes reads cheap and predictable, but every state-changing operation must update them correctly.
- Virtual reserves add extra arithmetic to quotes, but they make the novel feature easy to explain and test.
- The contract favors readability over micro-optimization because this is a course project.

## Next Steps

- Compare gas for normal and large swaps.
- Pack reserve values if token balances are intentionally bounded.
- Cache repeated storage reads inside state-changing functions.
- Add a gas report after the contract surface stabilizes.
