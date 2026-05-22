// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Mintable test token with EIP-2612 permit (signature-based approvals).
contract MockERC20 is ERC20Permit {
    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
