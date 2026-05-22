// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../core/Pool.sol";
import "../core/interfaces/IPoolFactory.sol";
import "../core/interfaces/IPoolSwapCallback.sol";
import "../libraries/TickMath.sol";
import "../libraries/SafeCast.sol";

/// @title Swap Router
/// @notice Stateless router for single-hop and multi-hop swaps through concentrated liquidity pools.
contract SwapRouter is IPoolSwapCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IPoolFactory public immutable factory;

    error DeadlineExpired();
    error TooLittleReceived();
    error TooMuchRequested();
    error PoolNotFound();
    error InvalidPath();

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes   path;       // abi.encodePacked(tokenA, fee, tokenB, fee, tokenC, …)
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    struct SwapCallbackData {
        bytes   path;
        address payer;
    }

    constructor(address _factory) {
        factory = IPoolFactory(_factory);
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    // ── IPoolSwapCallback ──────────────────────────────────────────────────────
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata _data
    ) external override {
        SwapCallbackData memory data = abi.decode(_data, (SwapCallbackData));
        (address tokenIn, address tokenOut, uint24 fee) = _decodeFirstPool(data.path);

        address expectedPool = factory.getPool(tokenIn, tokenOut, fee);
        require(msg.sender == expectedPool, "UNAUTHORIZED_POOL");

        int256 amountToPay = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (amountToPay > 0) {
            // For intermediate multi-hop steps the router itself holds the tokens — use transfer.
            // For the first hop (or single-hop) the user pays — use transferFrom.
            if (data.payer == address(this)) {
                IERC20(tokenIn).safeTransfer(msg.sender, uint256(amountToPay));
            } else {
                IERC20(tokenIn).safeTransferFrom(data.payer, msg.sender, uint256(amountToPay));
            }
        }
    }

    // ── Single-hop exact input ─────────────────────────────────────────────────
    /// @notice Swap an exact amount of one token for as many of another as possible (single pool).
    /// @param params  ExactInputSingleParams containing tokenIn, tokenOut, fee, amountIn, slippage, etc.
    /// @return amountOut Tokens received by the recipient
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        bool zeroForOne = params.tokenIn < params.tokenOut;
        (int256 amount0, int256 amount1) = _getPool(params.tokenIn, params.tokenOut, params.fee).swap(
            params.recipient,
            zeroForOne,
            params.amountIn.toInt256(),
            params.sqrtPriceLimitX96 == 0
                ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : params.sqrtPriceLimitX96,
            abi.encode(SwapCallbackData({
                path:  abi.encodePacked(params.tokenIn, params.fee, params.tokenOut),
                payer: msg.sender
            }))
        );
        amountOut = uint256(-(zeroForOne ? amount1 : amount0));
        if (amountOut < params.amountOutMinimum) revert TooLittleReceived();
    }

    // ── Single-hop exact output ────────────────────────────────────────────────
    /// @notice Swap as few input tokens as possible to receive an exact output amount (single pool).
    /// @param params  ExactOutputSingleParams with desired output amount and max input constraint
    /// @return amountIn Actual token0 or token1 spent
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        checkDeadline(params.deadline)
        returns (uint256 amountIn)
    {
        bool zeroForOne = params.tokenIn < params.tokenOut;
        (int256 amount0, int256 amount1) = _getPool(params.tokenIn, params.tokenOut, params.fee).swap(
            params.recipient,
            zeroForOne,
            -params.amountOut.toInt256(),
            params.sqrtPriceLimitX96 == 0
                ? (zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1)
                : params.sqrtPriceLimitX96,
            abi.encode(SwapCallbackData({
                path:  abi.encodePacked(params.tokenIn, params.fee, params.tokenOut),
                payer: msg.sender
            }))
        );
        amountIn = uint256(zeroForOne ? amount0 : amount1);
        if (amountIn > params.amountInMaximum) revert TooMuchRequested();
    }

    // ── Multi-hop exact input ──────────────────────────────────────────────────
    /// @notice Swap an exact amount of tokens along an encoded multi-hop path.
    ///         Path format: abi.encodePacked(tokenA, fee01, tokenB, fee12, tokenC, ...)
    /// @dev    Intermediate hops route through this contract; only the final hop sends to recipient.
    /// @param params  ExactInputParams with path, amountIn, and minimum amountOut
    /// @return amountOut Final tokens received by the recipient
    function exactInput(ExactInputParams calldata params)
        external
        checkDeadline(params.deadline)
        returns (uint256 amountOut)
    {
        address payer = msg.sender;
        uint256 amountIn = params.amountIn;
        bytes memory path = params.path;

        while (true) {
            bool hasMultiplePools = _hasMultiplePools(path);
            (address tokenIn, address tokenOut, uint24 fee) = _decodeFirstPool(path);
            bool zeroForOne = tokenIn < tokenOut;

            (int256 amount0, int256 amount1) = _getPool(tokenIn, tokenOut, fee).swap(
                hasMultiplePools ? address(this) : params.recipient,
                zeroForOne,
                amountIn.toInt256(),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                abi.encode(SwapCallbackData({ path: path, payer: payer }))
            );

            amountIn = uint256(-(zeroForOne ? amount1 : amount0));
            if (!hasMultiplePools) { amountOut = amountIn; break; }
            payer = address(this);
            path = _skipToken(path);
        }

        if (amountOut < params.amountOutMinimum) revert TooLittleReceived();
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    function _getPool(address tokenA, address tokenB, uint24 fee) private view returns (Pool) {
        address poolAddr = factory.getPool(tokenA, tokenB, fee);
        if (poolAddr == address(0)) revert PoolNotFound();
        return Pool(poolAddr);
    }

    /// @dev Path encoding: abi.encodePacked(address, uint24, address, uint24, address, ...)
    function _decodeFirstPool(bytes memory path) private pure returns (address tokenA, address tokenB, uint24 fee) {
        require(path.length >= 43, "INVALID_PATH");
        assembly {
            tokenA := shr(96, mload(add(path, 32)))
            fee    := shr(232, mload(add(path, 52)))
            tokenB := shr(96, mload(add(path, 55)))
        }
    }

    function _hasMultiplePools(bytes memory path) private pure returns (bool) {
        return path.length >= 66; // 20 + 3 + 20 + 3 + 20 = 66
    }

    function _skipToken(bytes memory path) private pure returns (bytes memory) {
        return _slice(path, 23, path.length - 23);
    }

    function _slice(bytes memory data, uint256 start, uint256 length) private pure returns (bytes memory result) {
        result = new bytes(length);
        assembly {
            let dest := add(result, 32)
            let src  := add(add(data, 32), start)
            for { let i := 0 } lt(i, length) { i := add(i, 32) } {
                mstore(add(dest, i), mload(add(src, i)))
            }
        }
    }
}
