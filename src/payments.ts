/**
 * Internal: x402 payment evidence as a charge, shared by the protocol adapters. Never throws. Only the amount, the
 * asset, the network, the settlement's success and its transaction hash are read; signatures, authorizations and payer
 * addresses are never copied.
 */
import { LIMITS } from './contract.ts';
import { peggedTo } from './currency.ts';
import type { ChargeInput } from './money.ts';
import { isRecord, NATIVE_ID, NETWORK, type Json } from './patterns.ts';

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** A non-negative integer amount of token atomic units, as x402 sends it; the limit is checked after parsing. */
const ATOMIC = /^\d{1,14}$/;
/** Larger headers are not x402 payloads; they are ignored before decoding. */
const MAX_HEADER = 16 * 1024;

/** Token contracts we can name, by address (EVM addresses lower-cased). Any other asset is not recorded. */
const ASSETS: ReadonlyMap<string, string> = new Map([
  ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC'], // Base
  ['0x036cbd53842c5426634e7929541ec2318f3dcf7e', 'USDC'], // Base Sepolia
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'USDC'], // Ethereum
  ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', 'USDC'], // Polygon
  ['0xaf88d065e77c8cc2239327c5edb3a432268e5831', 'USDC'], // Arbitrum One
  ['0x0b2c639c533813f4aa9d7837caf62653d097ff85', 'USDC'], // OP Mainnet
  ['0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', 'USDC'], // Avalanche C-Chain
  ['0x5425890298aed601595a70ab815c96711a31bc65', 'USDC'], // Avalanche Fuji
  ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'], // Solana
  ['4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', 'USDC'], // Solana devnet
  ['0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42', 'EURC'], // Base
  ['0x1abaea1f7c830bd89acc67ec4af516284b1bc33c', 'EURC'], // Ethereum
  ['0x808456652fdb597867f38412077a9182bf77359f', 'EURC'], // Base Sepolia
]);

/**
 * The currency of an x402 asset: USDC (the x402 default) when the payment names none, a known contract, or a
 * stablecoin symbol we peg; null for anything else, so an unknown token is never recorded as USDC.
 */
function currencyOf(asset: unknown): string | null {
  if (asset === undefined) return 'USDC';
  if (typeof asset !== 'string') return null;
  const contract = ASSETS.get(asset.startsWith('0x') ? asset.toLowerCase() : asset);
  if (contract) return contract;
  const symbol = asset.toUpperCase();
  return peggedTo(symbol) === null ? null : symbol;
}

function network(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) if (typeof candidate === 'string' && NETWORK.test(candidate)) return candidate;
  return undefined;
}

/**
 * A charge from a decoded x402 payment payload and settlement response, or null when either is missing or unusable.
 * Amount: the exact EVM scheme's `payload.authorization.value`, else (v2) `accepted.amount`, else
 * `accepted.maxAmountRequired`. Receipts are not verified on chain, so the basis is `reported`.
 */
export function x402Evidence(payment: unknown, settlement: unknown): ChargeInput | null {
  if (!isRecord(payment) || !isRecord(settlement)) return null;
  const { accepted } = payment;
  const raw = field(field(payment.payload, 'authorization'), 'value') ?? field(accepted, 'amount') ?? field(accepted, 'maxAmountRequired');
  if (typeof raw !== 'string' || !ATOMIC.test(raw)) return null;
  const amount = Number(raw);
  // A zero payment is no revenue: nothing to record.
  if (amount === 0 || amount > LIMITS.maxAmount) return null;
  const currency = currencyOf(field(accepted, 'asset'));
  if (!currency) return null;
  const chain = network(settlement.network, payment.network, field(accepted, 'network'));
  const { transaction } = settlement;
  return {
    amount,
    currency,
    method: 'x402',
    ...(chain ? { network: chain } : {}),
    status: settlement.success === true ? 'settled' : 'failed',
    basis: 'reported',
    ...(typeof transaction === 'string' && NATIVE_ID.test(transaction) ? { externalRef: transaction } : {}),
  };
}

/** A base64 (or base64url) JSON header as an object; null when absent, oversized or not an encoded JSON object. */
function decode(header: string | null): Json | null {
  if (!header || header.length > MAX_HEADER) return null;
  try {
    const value: unknown = JSON.parse(atob(header.trim().replace(/-/g, '+').replace(/_/g, '/')));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * A charge from the x402 headers of one HTTP exchange: the payment on the request (v2 `PAYMENT-SIGNATURE`, v1
 * `X-PAYMENT`) and the settlement on the response (v2 `PAYMENT-RESPONSE`, v1 `X-PAYMENT-RESPONSE`). Null unless both
 * are present and decode.
 */
export function x402Charge(request: Request, response: Response): ChargeInput | null {
  const payment = decode(request.headers.get('payment-signature') ?? request.headers.get('x-payment'));
  const settlement = decode(response.headers.get('payment-response') ?? response.headers.get('x-payment-response'));
  return payment && settlement ? x402Evidence(payment, settlement) : null;
}
