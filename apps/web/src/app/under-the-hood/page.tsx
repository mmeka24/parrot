import type { Metadata } from 'next';
import {
  ARC_TESTNET,
  GATEWAY_WALLET_ADDRESS,
  USDC_ADDRESS,
  addressUrl,
  technicalCopy,
} from '@parrot/shared';
import { getAgents, getSystemStatus } from '@/lib/api';
import { Panel } from '@/components/ui';

/**
 * JUDGES ONLY. This page is the documented exception to the vocabulary rule and
 * is the only screen allowed to use `technicalCopy`. Nothing here is linked from
 * the viewer or creator flows except through the global navigation.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: technicalCopy.underTheHoodTitle };

export default async function UnderTheHoodPage() {
  const [{ data: status }, { data: dashboard }] = await Promise.all([
    getSystemStatus(),
    getAgents(),
  ]);

  const caps: Array<[string, boolean]> = [
    ['On-chain settlement', status.capabilities.onchainSettlement],
    ['x402 payments', status.capabilities.x402Payments],
    ['ElevenLabs dubbing', status.capabilities.dubbing],
    ['QC language detection', status.capabilities.qcLanguageDetection],
    ['X API', status.capabilities.xApi],
    ['Grok parsing', status.capabilities.grokParsing],
    ['QuickNode Stream', status.capabilities.quicknodeStream],
  ];

  const addresses: Array<[string, string | null]> = [
    ['USDC (ERC-20 interface)', status.addresses.usdc || USDC_ADDRESS],
    ['Circle Gateway Wallet', status.addresses.gatewayWallet || GATEWAY_WALLET_ADDRESS],
    ['Revenue account', status.addresses.revenue],
    ['Treasury account', status.addresses.treasury],
  ];

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <header className="stack" style={{ ['--stack' as string]: '0.5rem' }}>
        <span className="eyebrow">{technicalCopy.chainLabel}</span>
        <h1 style={{ fontSize: '2rem' }}>{technicalCopy.underTheHoodTitle}</h1>
        <p style={{ color: 'var(--ink-soft)', maxWidth: '44rem' }}>
          {technicalCopy.underTheHoodSubtitle}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span className="chip chip-teal">
            {technicalCopy.latestBlock}: {dashboard.feed.latestBlock ?? '—'}
          </span>
          <span className="chip">
            {dashboard.feed.source === 'quicknode_stream'
              ? technicalCopy.streamLive
              : technicalCopy.streamStale}
          </span>
          <span className="chip">chainId {ARC_TESTNET.chainId}</span>
          <a
            className="btn btn-secondary"
            href={status.explorerUrl || ARC_TESTNET.explorerUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {technicalCopy.explorerCta}
          </a>
        </div>
      </header>

      <Panel title="Where the money goes">
        <MoneyFlow />
        <ul
          style={{
            margin: '1rem 0 0',
            paddingLeft: '1.1rem',
            color: 'var(--ink-soft)',
            fontSize: '0.9rem',
            display: 'grid',
            gap: '0.35rem',
          }}
        >
          <li>{technicalCopy.gatewayBatched}</li>
          <li>{technicalCopy.offChainCostNote}</li>
          <li>{technicalCopy.custodialNote}</li>
        </ul>
      </Panel>

      <Panel title="On-chain, batched, or simulated">
        <div className="table-scroll">
          <table className="data" style={{ minWidth: '28rem' }}>
            <thead>
              <tr>
                <th>Capability</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {caps.map(([label, on]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>
                    <span className={on ? 'chip chip-teal' : 'chip chip-berry'}>
                      {on ? 'Live' : 'Simulated'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul
          style={{
            margin: '1rem 0 0',
            paddingLeft: '1.1rem',
            color: 'var(--ink-soft)',
            fontSize: '0.9rem',
            display: 'grid',
            gap: '0.35rem',
          }}
        >
          {status.mocked.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Panel>

      <Panel title="Contract addresses" flush>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>What</th>
                <th>Address</th>
              </tr>
            </thead>
            <tbody>
              {addresses.map(([label, addr]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}>
                    {addr ? (
                      <a
                        href={addressUrl(addr)}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ color: 'var(--sky)', textDecoration: 'underline', wordBreak: 'break-all' }}
                      >
                        {addr}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
              <tr>
                <td>RPC</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', wordBreak: 'break-all' }}>
                  {ARC_TESTNET.rpcUrl}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/** The money-flow diagram: viewer -> gateway -> creator / agent, cost off to the side. */
function MoneyFlow() {
  const boxes = [
    { x: 8, label: 'Viewer', sub: '$0.02 unlock' },
    { x: 180, label: 'Gateway', sub: 'batched off-chain' },
    { x: 352, label: 'Arc', sub: 'on-chain settlement' },
  ];

  return (
    <svg viewBox="0 0 620 230" width="100%" role="img" aria-label="Money flow diagram" style={{ display: 'block' }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-faint)" />
        </marker>
      </defs>

      {boxes.map((b) => (
        <g key={b.label}>
          <rect
            x={b.x}
            y={28}
            width={150}
            height={64}
            rx={14}
            fill="var(--paper-sunk)"
            stroke="var(--rule-strong)"
          />
          <text x={b.x + 16} y={56} fontSize="15" fontWeight="650" fill="var(--ink)">
            {b.label}
          </text>
          <text x={b.x + 16} y={76} fontSize="12" fill="var(--ink-soft)">
            {b.sub}
          </text>
        </g>
      ))}

      <line x1={160} y1={60} x2={176} y2={60} stroke="var(--ink-faint)" strokeWidth="2" markerEnd="url(#arrow)" />
      <line x1={332} y1={60} x2={348} y2={60} stroke="var(--ink-faint)" strokeWidth="2" markerEnd="url(#arrow)" />

      <rect x={180} y={146} width={150} height={64} rx={14} fill="var(--teal-wash)" stroke="var(--teal)" />
      <text x={196} y={174} fontSize="15" fontWeight="650" fill="var(--ink)">
        Creator
      </text>
      <text x={196} y={194} fontSize="12" fill="var(--ink-soft)">
        60% — $0.012
      </text>

      <rect x={352} y={146} width={150} height={64} rx={14} fill="var(--mango-wash)" stroke="var(--mango)" />
      <text x={368} y={174} fontSize="15" fontWeight="650" fill="var(--ink)">
        Agent
      </text>
      <text x={368} y={194} fontSize="12" fill="var(--ink-soft)">
        40% — $0.008
      </text>

      <line x1={427} y1={96} x2={427} y2={142} stroke="var(--ink-faint)" strokeWidth="2" markerEnd="url(#arrow)" />
      <path d="M400 96 L400 120 L255 120 L255 142" fill="none" stroke="var(--ink-faint)" strokeWidth="2" markerEnd="url(#arrow)" />

      <rect x={520} y={28} width={92} height={64} rx={14} fill="var(--paper-sunk)" stroke="var(--rule-strong)" strokeDasharray="5 4" />
      <text x={534} y={56} fontSize="13" fontWeight="650" fill="var(--ink)">
        ElevenLabs
      </text>
      <text x={534} y={74} fontSize="11" fill="var(--ink-soft)">
        $0.40 fiat
      </text>
      <line x1={502} y1={178} x2={566} y2={178} stroke="var(--ink-faint)" strokeWidth="2" strokeDasharray="5 4" />
      <path d="M566 178 L566 96" fill="none" stroke="var(--ink-faint)" strokeWidth="2" strokeDasharray="5 4" markerEnd="url(#arrow)" />
    </svg>
  );
}
