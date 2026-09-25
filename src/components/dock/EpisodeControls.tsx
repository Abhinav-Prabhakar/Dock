"use client";

import React, { useState } from "react";
import { useEpisode } from "./EpisodeProvider";
import { Play, Pause, Square, FastForward } from "lucide-react";

export function EpisodeControls() {
  const { state, setState } = useEpisode();
  const [seed, setSeed] = useState(42);
  const [speed, setSpeed] = useState(20);

  const handleStart = () => {
    setState((s) => ({ ...s, status: "running" }));
  };

  const handlePause = () => {
    setState((s) => ({ ...s, status: "paused" }));
  };
  
  const handleStop = () => {
    setState((s) => ({ ...s, status: "idle", day: 0, metrics: null }));
  };

  return (
    <div className="panel-flat border-edge flex items-center justify-between px-6 py-2 border-b">
      <div className="flex items-center gap-4">
        <select 
          className="bg-transparent text-hi text-sm border border-edge rounded px-2 py-1 outline-none focus:border-accent"
          value={state.policy}
          onChange={(e) => setState(s => ({ ...s, policy: e.target.value }))}
        >
          <option className="bg-ink" value="static">Static</option>
          <option className="bg-ink" value="greedy">Greedy</option>
          <option className="bg-ink" value="heuristic">Heuristic</option>
          <option className="bg-ink" value="heuristic_bid">Heuristic Bid</option>
          <option className="bg-ink" value="ppo">PPO</option>
        </select>

        <select
          className="bg-transparent text-hi text-sm border border-edge rounded px-2 py-1 outline-none focus:border-accent"
          value={state.scenario}
          onChange={(e) => setState(s => ({ ...s, scenario: e.target.value }))}
        >
          <option className="bg-ink" value="baseline">Baseline</option>
          <option className="bg-ink" value="volatile-shocks">Volatile Shocks</option>
          <option className="bg-ink" value="depressed-demand">Depressed Demand</option>
        </select>

        <div className="flex items-center gap-2">
          <label className="text-low text-xs">Seed</label>
          <input 
            type="number" 
            value={seed} 
            onChange={(e) => setSeed(Number(e.target.value))}
            className="w-16 bg-transparent text-hi text-sm border border-edge rounded px-2 py-1 outline-none focus:border-accent"
          />
        </div>

        <div className="flex items-center gap-2">
          <FastForward size={14} className="text-low" />
          <input 
            type="range" 
            min="0.5" 
            max="120" 
            step="0.5"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="w-24 accent-accent"
          />
          <span className="text-low text-xs w-6">{speed}</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-mid text-sm font-display font-medium w-16 text-right">
          Day {state.day}
        </div>
        
        <div className="flex items-center gap-1 border-l border-edge pl-3">
          {state.status === 'idle' || state.status === 'paused' ? (
            <button onClick={handleStart} className="p-1.5 text-accent hover:text-accent-hi transition-colors" title="Start">
              <Play size={18} fill="currentColor" />
            </button>
          ) : (
            <button onClick={handlePause} className="p-1.5 text-warn hover:text-yellow-400 transition-colors" title="Pause">
              <Pause size={18} fill="currentColor" />
            </button>
          )}
          
          <button 
            onClick={handleStop} 
            disabled={state.status === 'idle'}
            className="p-1.5 text-low hover:text-critical transition-colors disabled:opacity-50 disabled:hover:text-low" 
            title="Stop"
          >
            <Square size={18} fill="currentColor" />
          </button>
        </div>
      </div>
    </div>
  );
}
