import { useState, useCallback, useMemo } from 'react';
import { BrowserProvider } from 'ethers';
import { REQUIRED_CHAIN_ID } from '../constants.js';

export function useWallet() {
  const [account, setAccount] = useState('');
  const [error, setError]     = useState('');

  const provider = useMemo(() => {
    if (typeof window === 'undefined' || !window.ethereum) return null;
    return new BrowserProvider(window.ethereum);
  }, []);

  const connect = useCallback(async () => {
    setError('');
    if (!provider) { setError('Install MetaMask or another injected wallet.'); return; }
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== REQUIRED_CHAIN_ID) {
        setError(`Wrong network — switch MetaMask to Hardhat Local (chain ID 31337).`);
        return;
      }
      const signer = await provider.getSigner();
      setAccount(await signer.getAddress());
    } catch (e) {
      setError(e.shortMessage || e.reason || e.message || 'Connection failed.');
    }
  }, [provider]);

  const getSigner = useCallback(async () => {
    if (!provider) throw new Error('No wallet found.');
    return provider.getSigner();
  }, [provider]);

  return { account, provider, getSigner, connect, walletError: error };
}
