import { describe, it, expect } from 'vitest';
import {
  doneTriggersRefetch,
  actionTriggersRefetch,
  evaluateStreamOutcome,
  extractOrderIds,
} from '../lib/chatEvents.js';

describe('chatEvents — Booking Desk live-update decisions', () => {
  it('a done payload with orders_changed triggers a refetch', () => {
    expect(doneTriggersRefetch({ orders_changed: true })).toBe(true);
    expect(doneTriggersRefetch({ orders_changed: false })).toBe(false);
    expect(doneTriggersRefetch(null)).toBe(false);
  });

  it('only the "action" SSE event (not delta/status/reset) triggers a refetch', () => {
    expect(actionTriggersRefetch('action')).toBe(true);
    expect(actionTriggersRefetch('delta')).toBe(false);
    expect(actionTriggersRefetch('status')).toBe(false);
    expect(actionTriggersRefetch('reset')).toBe(false);
  });

  it('evaluateStreamOutcome: a mid-stream booking action triggers a refetch even if the final reply text is plain', () => {
    const outcome = evaluateStreamOutcome({
      events: [
        { event: 'status', data: { text: 'pricing…' } },
        { event: 'delta', data: { text: 'Booked it.' } },
        { event: 'action', data: { kind: 'booked', text: 'Booked', order_id: 'BK-2481-TC' } },
      ],
      done: { reply: 'Booked it.', actions: [{ kind: 'booked' }], orders_changed: true },
    });
    expect(outcome.shouldRefetch).toBe(true);
    expect(outcome.orderIds).toContain('BK-2481-TC');
  });

  it('evaluateStreamOutcome: a quote-only conversation with no action and orders_changed:false does not refetch', () => {
    const outcome = evaluateStreamOutcome({
      events: [{ event: 'delta', data: { text: 'Here is a quote for BK-1000-TC.' } }],
      done: { reply: 'Here is a quote for BK-1000-TC.', actions: [], orders_changed: false },
    });
    expect(outcome.shouldRefetch).toBe(false);
    // order ids are still surfaced so the UI can offer to focus them
    expect(outcome.orderIds).toEqual(['BK-1000-TC']);
  });

  it('evaluateStreamOutcome: orders_changed alone (no explicit action event) still triggers a refetch', () => {
    const outcome = evaluateStreamOutcome({
      events: [{ event: 'delta', data: { text: 'Declined.' } }],
      done: { reply: 'Declined.', orders_changed: true },
    });
    expect(outcome.shouldRefetch).toBe(true);
  });

  it('extractOrderIds finds every distinct BK-####-XX id, in first-seen order', () => {
    const ids = extractOrderIds('BK-2481-TC and BK-1000-AB, then BK-2481-TC again');
    expect(ids).toEqual(['BK-2481-TC', 'BK-1000-AB']);
  });

  it('extractOrderIds returns an empty list for text with no order ids', () => {
    expect(extractOrderIds('Nothing to see here.')).toEqual([]);
  });
});
