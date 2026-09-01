import 'reflect-metadata';
import {paginate} from '../src/utils/pagination';
import {MAX_QUERY_LIMIT} from '../src/utils/constants';

/**
 * `paginate` exists because the hand-written version is wrong in a way that
 * runs. These pin the parts that are easy to get subtly wrong: the total is the
 * total and not the page size, the limit has a ceiling, and `hasMore` is right
 * at the boundary.
 */

/** A Parse.Query stand-in that records what was asked of it. */
function fakeQuery(page: unknown) {
  const calls: Record<string, unknown> = {};
  const q = {
    limit(n: number) { calls.limit = n; return q; },
    skip(n: number) { calls.skip = n; return q; },
    withCount() { calls.withCount = true; return q; },
    addDescending(k: string) { (calls.tiebreak ??= []); (calls.tiebreak as string[]).push(k); return q; },
    find(options: unknown) { calls.findOptions = options; return Promise.resolve(page); },
  };
  return {q: q as unknown as Parse.Query, calls};
}

describe('paginate', () => {
  it('returns the TOTAL, not the size of this page', async () => {
    // The mistake this replaces: returning results.length, which is 2 here and
    // tells a client nothing about the other 98 rows.
    const {q} = fakeQuery({results: [{}, {}], count: 100});
    const page = await paginate(q, {});

    expect(page.count).toBe(100);
    expect(page.results).toHaveLength(2);
  });

  it('asks the query for a count rather than running a second query', async () => {
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {});
    expect(calls.withCount).toBe(true);
  });

  it('defaults to 20 per page', async () => {
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {});
    expect(calls.limit).toBe(20);
    expect(calls.skip).toBe(0);
  });

  it('accepts limit and skip as STRINGS, which is how GET sends them', async () => {
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {limit: '5', skip: '10'});
    expect(calls.limit).toBe(5);
    expect(calls.skip).toBe(10);
  });

  it('caps the limit, so ?limit=999999 is not a denial of service', async () => {
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {limit: '999999'});
    expect(calls.limit).toBe(MAX_QUERY_LIMIT);
  });

  it('honours a lower maxLimit when one is given', async () => {
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {limit: '500'}, {maxLimit: 50});
    expect(calls.limit).toBe(50);
  });

  it('falls back to the default for nonsense input', async () => {
    for (const bad of ['abc', '', null, undefined, -5]) {
      const {q, calls} = fakeQuery({results: [], count: 0});
      await paginate(q, {limit: bad});
      expect(calls.limit).toBe(20);
    }
  });

  it('says there is more when the page does not reach the end', async () => {
    const {q} = fakeQuery({results: new Array(20).fill({}), count: 100});
    const page = await paginate(q, {limit: '20', skip: '0'});
    expect(page.hasMore).toBe(true);
  });

  it('says there is no more on the exact last page', async () => {
    // The boundary an off-by-one lives at: 80 + 20 === 100.
    const {q} = fakeQuery({results: new Array(20).fill({}), count: 100});
    const page = await paginate(q, {limit: '20', skip: '80'});
    expect(page.hasMore).toBe(false);
  });

  it('says there is no more when the result set is empty', async () => {
    const {q} = fakeQuery({results: [], count: 0});
    const page = await paginate(q, {});
    expect(page.hasMore).toBe(false);
  });

  it('passes useMasterKey and sessionToken through to find', async () => {
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {}, {useMasterKey: true});
    expect(calls.findOptions).toEqual({useMasterKey: true});

    const b = fakeQuery({results: [], count: 0});
    await paginate(b.q, {}, {sessionToken: 'r:abc'});
    expect(b.calls.findOptions).toEqual({sessionToken: 'r:abc'});
  });

  it('survives an SDK that returns a plain array despite withCount', async () => {
    // Defensive: the {results, count} shape comes from a cast, not the type
    // system. If a future SDK stops honouring it, still return the rows.
    const {q} = fakeQuery([{}, {}]);
    const page = await paginate(q, {});

    expect(page.results).toHaveLength(2);
    expect(page.count).toBe(2);
    expect(page.hasMore).toBe(false);
  });

  it('appends a tiebreaker so the order is total', async () => {
    // Paging needs a TOTAL order. A caller who sorts by a low-cardinality
    // column - status, say - has ties, and ties page exactly as badly as no
    // sort at all. Appended, so it never overrides the caller's own order.
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {});
    expect(calls.tiebreak).toEqual(['createdAt']);
  });

  it('can be told not to, for a caller who knows their indexes', async () => {
    // The extra sort key is not free: a sort MongoDB cannot serve from an
    // index runs in memory and is capped at 32MB, so `price` may be indexed
    // while `price, createdAt` is not.
    const {q, calls} = fakeQuery({results: [], count: 0});
    await paginate(q, {}, {tiebreak: false});
    expect(calls.tiebreak).toBeUndefined();
  });
});