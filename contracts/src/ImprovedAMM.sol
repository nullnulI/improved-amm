// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ImprovedAMM is ERC20, Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant BASE_FEE_BPS = 30;
    uint256 public constant LARGE_TRADE_FEE_BPS = 50;
    uint256 public constant LARGE_TRADE_THRESHOLD_BPS = 1_000;
    uint256 private constant MINIMUM_LIQUIDITY = 1_000;

    IERC20 public immutable token0;
    IERC20 public immutable token1;

    uint256 public reserve0;
    uint256 public reserve1;
    uint256 public virtualReserve0;
    uint256 public virtualReserve1;

    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event LiquidityRemoved(address indexed provider, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Swap(
        address indexed trader,
        address indexed tokenIn,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeBps
    );
    event VirtualReservesUpdated(uint256 virtualReserve0, uint256 virtualReserve1);

    error InvalidToken();
    error Expired();
    error InsufficientLiquidity();
    error InsufficientOutput();
    error InvalidAmount();

    constructor(
        IERC20 token0_,
        IERC20 token1_,
        uint256 virtualReserve0_,
        uint256 virtualReserve1_
    ) ERC20("Improved AMM LP", "iAMM-LP") Ownable(msg.sender) {
        if (address(token0_) == address(0) || address(token1_) == address(0) || token0_ == token1_) {
            revert InvalidToken();
        }

        token0 = token0_;
        token1 = token1_;
        virtualReserve0 = virtualReserve0_;
        virtualReserve1 = virtualReserve1_;
    }

    function addLiquidity(
        uint256 amount0,
        uint256 amount1,
        uint256 minLiquidity,
        uint256 deadline
    ) external returns (uint256 liquidity) {
        _checkDeadline(deadline);
        if (amount0 == 0 || amount1 == 0) revert InvalidAmount();

        uint256 totalLp = totalSupply();
        if (totalLp == 0) {
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
        } else {
            uint256 liquidity0 = (amount0 * totalLp) / reserve0;
            uint256 liquidity1 = (amount1 * totalLp) / reserve1;
            liquidity = liquidity0 < liquidity1 ? liquidity0 : liquidity1;
        }

        if (liquidity == 0 || liquidity < minLiquidity) revert InsufficientLiquidity();

        token0.safeTransferFrom(msg.sender, address(this), amount0);
        token1.safeTransferFrom(msg.sender, address(this), amount1);

        reserve0 += amount0;
        reserve1 += amount1;

        _mint(msg.sender, liquidity);
        emit LiquidityAdded(msg.sender, amount0, amount1, liquidity);
    }

    function removeLiquidity(
        uint256 liquidity,
        uint256 minAmount0,
        uint256 minAmount1,
        uint256 deadline
    ) external returns (uint256 amount0, uint256 amount1) {
        _checkDeadline(deadline);
        if (liquidity == 0) revert InvalidAmount();

        uint256 totalLp = totalSupply();
        amount0 = (liquidity * reserve0) / totalLp;
        amount1 = (liquidity * reserve1) / totalLp;

        if (amount0 < minAmount0 || amount1 < minAmount1) revert InsufficientOutput();

        _burn(msg.sender, liquidity);
        reserve0 -= amount0;
        reserve1 -= amount1;

        token0.safeTransfer(msg.sender, amount0);
        token1.safeTransfer(msg.sender, amount1);

        emit LiquidityRemoved(msg.sender, amount0, amount1, liquidity);
    }

    function swapExactIn(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        _checkDeadline(deadline);
        if (amountIn == 0) revert InvalidAmount();

        (IERC20 input, IERC20 output, bool zeroForOne) = _pairFor(tokenIn);
        uint256 feeBps = currentFeeBps(tokenIn, amountIn);
        amountOut = quoteSwap(tokenIn, amountIn);
        if (amountOut == 0 || amountOut < minAmountOut) revert InsufficientOutput();

        input.safeTransferFrom(msg.sender, address(this), amountIn);

        if (zeroForOne) {
            if (amountOut >= reserve1) revert InsufficientLiquidity();
            reserve0 += amountIn;
            reserve1 -= amountOut;
        } else {
            if (amountOut >= reserve0) revert InsufficientLiquidity();
            reserve1 += amountIn;
            reserve0 -= amountOut;
        }

        output.safeTransfer(msg.sender, amountOut);
        emit Swap(msg.sender, tokenIn, amountIn, amountOut, feeBps);
    }

    function quoteSwap(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        if (amountIn == 0) revert InvalidAmount();

        bool zeroForOne;
        if (tokenIn == address(token0)) {
            zeroForOne = true;
        } else if (tokenIn == address(token1)) {
            zeroForOne = false;
        } else {
            revert InvalidToken();
        }

        (uint256 actualReserveIn, uint256 actualReserveOut, uint256 virtualReserveIn, uint256 virtualReserveOut) =
            zeroForOne
                ? (reserve0, reserve1, virtualReserve0, virtualReserve1)
                : (reserve1, reserve0, virtualReserve1, virtualReserve0);

        if (actualReserveIn == 0 || actualReserveOut == 0) revert InsufficientLiquidity();

        uint256 feeBps = currentFeeBps(tokenIn, amountIn);
        uint256 amountInAfterFee = (amountIn * (BPS - feeBps)) / BPS;
        uint256 pricedReserveIn = actualReserveIn + virtualReserveIn;
        uint256 pricedReserveOut = actualReserveOut + virtualReserveOut;

        amountOut = (amountInAfterFee * pricedReserveOut) / (pricedReserveIn + amountInAfterFee);

        if (amountOut == 0) revert InsufficientOutput();
        if (amountOut >= actualReserveOut) revert InsufficientLiquidity();
    }

    function currentFeeBps(address tokenIn, uint256 amountIn) public view returns (uint256) {
        uint256 reserveIn;
        if (tokenIn == address(token0)) {
            reserveIn = reserve0;
        } else if (tokenIn == address(token1)) {
            reserveIn = reserve1;
        } else {
            revert InvalidToken();
        }

        if (reserveIn > 0 && amountIn * BPS >= reserveIn * LARGE_TRADE_THRESHOLD_BPS) {
            return LARGE_TRADE_FEE_BPS;
        }
        return BASE_FEE_BPS;
    }

    function getReserves() external view returns (uint256, uint256) {
        return (reserve0, reserve1);
    }

    function updateVirtualReserves(uint256 virtualReserve0_, uint256 virtualReserve1_) external onlyOwner {
        virtualReserve0 = virtualReserve0_;
        virtualReserve1 = virtualReserve1_;
        emit VirtualReservesUpdated(virtualReserve0_, virtualReserve1_);
    }

    function _pairFor(address tokenIn) private view returns (IERC20 input, IERC20 output, bool zeroForOne) {
        if (tokenIn == address(token0)) {
            return (token0, token1, true);
        }
        if (tokenIn == address(token1)) {
            return (token1, token0, false);
        }
        revert InvalidToken();
    }

    function _checkDeadline(uint256 deadline) private view {
        if (block.timestamp > deadline) revert Expired();
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
