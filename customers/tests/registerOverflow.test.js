import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(
  path.join(process.cwd(), 'public/dashboard/style.css'),
  'utf8'
);

/** Grab a rule body by selector, tolerant of the exact original formatting. */
function ruleBody(selector) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'
  );
  const m = re.exec(css);
  if (!m) throw new Error(`selector not found: ${selector}`);
  return m[1];
}

function isTruncated(body) {
  return /white-space:\s*nowrap/.test(body) &&
         /overflow:\s*hidden/.test(body) &&
         /text-overflow:\s*ellipsis/.test(body);
}

describe('waybill register — no overflow/overlap in the ledger table', () => {
  it('the booking id and its "filed" caption truncate instead of wrapping', () => {
    expect(isTruncated(ruleBody('.c-id b'))).toBe(true);
    expect(isTruncated(ruleBody('.c-id i'))).toBe(true);
  });

  it('the consignment TEU figure truncates instead of colliding with the vessel column', () => {
    expect(isTruncated(ruleBody('.c-cons .teu'))).toBe(true);
  });

  it('the route cell cannot wrap onto a second line', () => {
    const body = ruleBody('.c-route');
    expect(/white-space:\s*nowrap/.test(body)).toBe(true);
    expect(/min-width:\s*0/.test(body)).toBe(true);
  });

  it('the ledger header row ("WINDOW / ETA" etc.) truncates instead of spilling past the sheet edge', () => {
    expect(isTruncated(ruleBody('.lhead span'))).toBe(true);
  });

  it('every grid cell can still shrink below its content size (min-width: 0 on .lrow > span)', () => {
    expect(/min-width:\s*0/.test(ruleBody('.lrow > span'))).toBe(true);
  });

  it('the vessel column already truncated in the original design (regression guard)', () => {
    expect(isTruncated(ruleBody('.c-vessel b'))).toBe(true);
  });

  it('the pinned detail card value rows truncate long vessel/price values', () => {
    expect(isTruncated(ruleBody('.d-rows .r b'))).toBe(true);
  });

  it('the quote-review sheet value rows truncate long values', () => {
    expect(isTruncated(ruleBody('.lrows .r b'))).toBe(true);
  });
});
