"use client";

import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api, type SummaryData, type TimelineData } from '@/lib/api';

interface ComparisonDialogProps {
  open: boolean;
  onClose: () => void;
}

const POLICY_COLORS: Record<string, string> = {
  static: '#6b7280',
  greedy: '#3b82f6',
  heuristic: '#f59e0b',
  heuristic_bid: '#14b8a6',
  ppo: '#22c55e',
};

const POLICY_NAMES: Record<string, string> = {
  static: 'Static Rate Card',
  greedy: 'Greedy',
  heuristic: 'Dynamic Heuristic',
  heuristic_bid: 'Bid-Price Heuristic',
  ppo: 'Dock (PPO)',
};

const POLICY_ORDER = ['static', 'greedy', 'heuristic', 'heuristic_bid', 'ppo'];

function formatCurrencyM(val: number) {
  return `$${(val / 1000000).toFixed(1)}M`;
}

function formatPct(val: number) {
  return `${(val * 100).toFixed(1)}%`;
}

export default function ComparisonDialog({ open, onClose }: ComparisonDialogProps) {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (open) {
      setLoading(true);
      Promise.all([
        api.getCompare('summary'),
        api.getCompare('timeline')
      ]).then(([sData, tData]) => {
        setSummary(sData);
        setTimeline(tData);
      }).catch(console.error).finally(() => setLoading(false));
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="relative w-full max-w-6xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-800">
          <h2 className="text-2xl font-bold text-white">Policy Performance Comparison</h2>
          <button onClick={onClose} className="p-2 text-slate-400 hover:text-white rounded-full hover:bg-slate-800 transition-colors">
            <X size={24} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-8">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-slate-400">Loading data...</div>
          ) : (
            <>
              {summary && <PolicyLadder summary={summary} />}
              {timeline && <RacingChart timeline={timeline} />}
              {summary && <MetricsChips summary={summary} />}
              {summary && <SegmentStrip summary={summary} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PolicyLadder({ summary }: { summary: SummaryData }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
      {POLICY_ORDER.map(policyKey => {
        const policy = summary.policies[policyKey];
        if (!policy) return null;
        const lift = summary.lift_vs_static?.[policyKey];
        const isPPO = policyKey === 'ppo';
        
        return (
          <div key={policyKey} className={`relative p-5 rounded-xl border ${isPPO ? 'border-green-500/50 bg-green-500/10 shadow-[0_0_15px_rgba(34,197,94,0.1)]' : 'border-slate-800 bg-slate-800/50'}`}>
            <h3 className={`font-semibold mb-1 ${isPPO ? 'text-green-400 text-lg' : 'text-slate-200'}`}>
              {POLICY_NAMES[policyKey] || policyKey}
            </h3>
            
            <div className="mt-4 mb-3">
              <div className="text-3xl font-bold text-white tracking-tight">
                {formatCurrencyM(policy.profit_usd.mean)}
              </div>
              <div className="text-sm text-slate-400 mt-1">
                ± {formatCurrencyM(policy.profit_usd.std)}
              </div>
            </div>
            
            {lift && policyKey !== 'static' && (
              <div className="mb-4">
                <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${lift.profit_usd_pct > 0 ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                  {lift.profit_usd_pct > 0 ? '+' : ''}{formatPct(lift.profit_usd_pct)} profit
                </span>
              </div>
            )}
            
            <div className="space-y-2 mt-4 pt-4 border-t border-slate-700/50 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Rev/TEU</span>
                <span className="font-medium text-slate-200">${policy.revenue_per_teu.mean.toFixed(0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Utilization</span>
                <span className="font-medium text-slate-200">{formatPct(policy.utilization.mean)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RacingChart({ timeline }: { timeline: TimelineData }) {
  const width = 1000;
  const height = 350;
  const margin = { top: 20, right: 40, bottom: 40, left: 60 };
  
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  let maxProfit = 0;
  const allDays = 90; // Horizon is 90 days

  Object.values(timeline.policies).forEach(days => {
    days.forEach(d => {
      if (d.cum_profit > maxProfit) maxProfit = d.cum_profit;
    });
  });
  
  // Round max up to nearest 10M for nice grid
  const yMax = Math.max(1, Math.ceil(maxProfit / 10000000) * 10000000);
  
  const getX = (day: number) => margin.left + ((day - 1) / (allDays - 1)) * innerWidth;
  const getY = (val: number) => height - margin.bottom - (val / yMax) * innerHeight;
  
  const yTicks = [0, yMax * 0.25, yMax * 0.5, yMax * 0.75, yMax];
  const xTicks = [1, 15, 30, 45, 60, 75, 90];

  return (
    <div className="bg-slate-800/30 border border-slate-800 rounded-xl p-4">
      <h3 className="text-lg font-medium text-white mb-4 pl-2">Cumulative Profit (90 Days)</h3>
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto min-w-[600px]">
          {/* Grid lines and Y-axis labels */}
          {yTicks.map((tick, i) => (
            <g key={`y-${i}`}>
              <line x1={margin.left} y1={getY(tick)} x2={width - margin.right} y2={getY(tick)} stroke="#334155" strokeWidth="1" strokeDasharray="4 4" />
              <text x={margin.left - 10} y={getY(tick)} fill="#94a3b8" fontSize="12" textAnchor="end" dominantBaseline="middle">
                ${(tick / 1000000).toFixed(0)}M
              </text>
            </g>
          ))}
          
          {/* X-axis labels */}
          {xTicks.map((tick, i) => (
            <g key={`x-${i}`}>
              <line x1={getX(tick)} y1={height - margin.bottom} x2={getX(tick)} y2={height - margin.bottom + 5} stroke="#475569" strokeWidth="1" />
              <text x={getX(tick)} y={height - margin.bottom + 20} fill="#94a3b8" fontSize="12" textAnchor="middle">
                Day {tick}
              </text>
            </g>
          ))}
          
          {/* Lines */}
          {POLICY_ORDER.map(policyKey => {
            const data = timeline.policies[policyKey];
            if (!data || data.length === 0) return null;
            
            const points = data.map(d => `${getX(d.day)},${getY(d.cum_profit)}`).join(' ');
            
            return (
              <polyline 
                key={policyKey}
                points={points}
                fill="none"
                stroke={POLICY_COLORS[policyKey] || '#ffffff'}
                strokeWidth={policyKey === 'ppo' ? "4" : "2"}
                strokeLinejoin="round"
                strokeLinecap="round"
                className={policyKey === 'ppo' ? 'drop-shadow-md' : ''}
              />
            );
          })}
        </svg>
      </div>
      
      {/* Legend */}
      <div className="flex flex-wrap items-center justify-center gap-6 mt-4">
        {POLICY_ORDER.map(key => (
          <div key={key} className="flex items-center gap-2">
            <div className="w-4 h-1 rounded" style={{ backgroundColor: POLICY_COLORS[key] }}></div>
            <span className={`text-sm ${key === 'ppo' ? 'text-green-400 font-medium' : 'text-slate-300'}`}>
              {POLICY_NAMES[key]}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricsChips({ summary }: { summary: SummaryData }) {
  const ppo = summary.policies.ppo;
  const staticPol = summary.policies.static;
  if (!ppo || !staticPol) return null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      <MetricChip title="Utilization" value={formatPct(ppo.utilization.mean)} compare={ppo.utilization.mean - staticPol.utilization.mean} compareFmt={v => `${v > 0 ? '+' : ''}${formatPct(v)}`} />
      <MetricChip title="CO₂ / TEU" value={`${ppo.co2_per_teu.mean.toFixed(2)} t`} compare={ppo.co2_per_teu.mean - staticPol.co2_per_teu.mean} compareFmt={v => `${v > 0 ? '+' : ''}${v.toFixed(2)} t`} reverseColor />
      <MetricChip title="Empty TEU-nm" value={(ppo.empty_teu_nm.mean / 1000000).toFixed(1) + 'M'} compare={(ppo.empty_teu_nm.mean - staticPol.empty_teu_nm.mean) / 1000000} compareFmt={v => `${v > 0 ? '+' : ''}${v.toFixed(1)}M`} reverseColor />
      <MetricChip title="Counter Win Rate" value={formatPct(ppo.counter_win_rate?.mean || 0)} />
      <MetricChip title="Reject → Counter" value={formatPct(ppo.reject_to_counter_conv?.mean || 0)} />
    </div>
  );
}

function MetricChip({ title, value, compare, compareFmt, reverseColor = false }: { title: string, value: string, compare?: number, compareFmt?: (v: number) => string, reverseColor?: boolean }) {
  let colorClass = 'text-slate-400';
  if (compare !== undefined) {
    if (compare > 0) colorClass = reverseColor ? 'text-red-400' : 'text-green-400';
    if (compare < 0) colorClass = reverseColor ? 'text-green-400' : 'text-red-400';
  }
  
  return (
    <div className="bg-slate-800/40 border border-slate-700/60 rounded-lg p-3 flex flex-col justify-center">
      <div className="text-xs text-slate-400 mb-1">{title}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-medium text-slate-200">{value}</span>
        {compare !== undefined && compare !== 0 && compareFmt && (
          <span className={`text-xs ${colorClass}`}>{compareFmt(compare)}</span>
        )}
      </div>
    </div>
  );
}

function SegmentStrip({ summary }: { summary: SummaryData }) {
  const ppo = summary.policies.ppo;
  if (!ppo || !ppo.segments) return null;

  return (
    <div className="bg-slate-800/40 border border-slate-700/60 rounded-xl p-5">
      <h3 className="text-sm font-medium text-slate-300 mb-4">Dock (PPO) Segment Performance</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {['urgent', 'standard', 'flexible'].map(seg => {
          const stats = ppo.segments[seg as keyof typeof ppo.segments];
          if (!stats) return null;
          
          const fillPct = stats.requests > 0 ? (stats.booked / stats.requests) * 100 : 0;
          
          return (
            <div key={seg}>
              <div className="flex justify-between text-sm mb-2">
                <span className="capitalize text-slate-200">{seg}</span>
                <span className="text-slate-400">{stats.booked.toFixed(0)} / {stats.requests.toFixed(0)} booked</span>
              </div>
              <div className="w-full bg-slate-700 h-2 rounded-full overflow-hidden">
                <div 
                  className="bg-green-500 h-full rounded-full" 
                  style={{ width: `${fillPct}%` }} 
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
