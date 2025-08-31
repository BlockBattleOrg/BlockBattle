// ... na vrhu filea (ili gdje već imaš util funkcije)
function explorerTxUrl(chain: string | null | undefined, tx: string | null | undefined) {
  if (!tx) return '#';
  const c = String(chain || '').toUpperCase();

  // L1 / EVM
  if (c === 'ETH') return `https://etherscan.io/tx/${tx}`;
  if (c === 'BSC') return `https://bscscan.com/tx/${tx}`;
  if (c === 'ARB') return `https://arbiscan.io/tx/${tx}`;
  if (c === 'OP')  return `https://optimistic.etherscan.io/tx/${tx}`;
  if (c === 'POL' || c === 'MATIC' || c === 'POLYGON') return `https://polygonscan.com/tx/${tx}`;
  if (c === 'AVAX') return `https://snowtrace.io/tx/${tx}`;
  if (c === 'TRX')  return `https://tronscan.org/#/transaction/${tx}`;

  // BTC-like (tx hash bez 0x)
  if (c === 'BTC')  return `https://mempool.space/tx/${tx}`;
  if (c === 'LTC')  return `https://blockchair.com/litecoin/transaction/${tx}`;
  if (c === 'DOGE') return `https://blockchair.com/dogecoin/transaction/${tx}`;

  // Cosmos / others – nemaju univerzalni explorer per se; placeholder (možeš zamijeniti vlastitim)
  if (c === 'ATOM') return `https://www.mintscan.io/cosmos/tx/${tx}`;
  if (c === 'DOT')  return `https://polkadot.subscan.io/extrinsic/${tx}`;
  if (c === 'XRP')  return `https://xrpscan.com/tx/${tx}`;
  if (c === 'XLM')  return `https://stellarchain.io/transactions/${tx}`;
  if (c === 'SOL')  return `https://solscan.io/tx/${tx}`;

  return '#';
}

