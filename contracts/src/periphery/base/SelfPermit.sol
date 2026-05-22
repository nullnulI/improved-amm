// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/// @title SelfPermit
/// @notice Lets a caller grant this contract an allowance via an EIP-2612 signature.
///         Combined with {Multicall}, the permit and the action (swap/mint) execute in a
///         single transaction, removing the need for a separate `approve` transaction.
/// @dev    Intended to be the first call in a multicall batch. Because Multicall uses
///         delegatecall, `msg.sender` is the original caller, so the allowance is granted
///         by and for that user.
abstract contract SelfPermit {
    /// @notice Approve this contract to spend `value` of `token` using an EIP-2612 signature.
    function selfPermit(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public {
        IERC20Permit(token).permit(msg.sender, address(this), value, deadline, v, r, s);
    }

    /// @notice Same as {selfPermit} but skips the permit if the allowance already covers
    ///         `value`. This prevents a griefer who front-runs the permit (consuming the
    ///         signature's nonce) from reverting the whole multicall.
    function selfPermitIfNecessary(
        address token,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (IERC20(token).allowance(msg.sender, address(this)) < value) {
            selfPermit(token, value, deadline, v, r, s);
        }
    }
}
