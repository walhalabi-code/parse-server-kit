import {MAX_QUERY_LIMIT} from './constants';

/**
 * One page of results, and enough to ask for the next.
 *
 * `count` is the TOTAL number of rows matching the filter, not the size of
 * this page. That distinction is the whole point: a client cannot draw
 * "page 3 of 12", or decide whether to enable a next button, from the length
 * of an array it already has.
 */
export interface Page<T> {
  results: T[];
  /** Total rows matching the query, across all pages. */
  count: number;
  limit: number;
  skip: number;
  hasMore: boolean;
}

export interface PaginateOptions {
  /** Page size when the caller does not ask for one. Default 20. */
  defaultLimit?: number;
  /** Ceiling on the page size, however large a limit is requested. Default `MAX_QUERY_LIMIT`. */
  maxLimit?: number;
  /** Passed through to `find()`. */
  useMasterKey?: boolean;
  /** Passed through to `find()`. */
  sessionToken?: string;
  /**
   * Append a `createdAt` tiebreaker to the sort. Default `true`.
   *
   * Paging needs a TOTAL order, and "sort your query" is not enough advice:
   * sorting by a low-cardinality column leaves ties, and ties page exactly as
   * badly as no sort at all — a hundred rows sharing `status: 'draft'` can
   * repeat across pages or vanish between them, with nothing reported.
   *
   * Appended, never imposed, so it only settles what your own order leaves
   * undecided.
   *
   * Set `false` when you already sort by something unique, or when the extra
   * key costs you: a sort MongoDB cannot serve from an index is done in memory
   * and capped at 32 MB, so on a large collection `price` may be indexed while
   * `price, createdAt` is not. If you turn it off, sort by something unique —
   * `objectId` works — or accept that pages will not be stable.
   */
  tiebreak?: boolean;
}

/** What arrives in `req.params`. GET values are strings; POST values may not be. */
interface PageParams {
  limit?: unknown;
  skip?: unknown;
}

function toPositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * Run a query as one page of a paginated list.
 *
 * ```ts
 * const query = new Parse.Query(Note).descending('createdAt');
 * return paginate<Note>(query, req.params, {useMasterKey: true});
 * // → {results, count, limit, skip, hasMore}
 * ```
 *
 * This exists because the obvious hand-written version is wrong in a way that
 * runs perfectly. Returning `results.length` as the count gives the size of the
 * page you already have — a number no client can paginate with — and nothing
 * fails: the endpoint answers 200 with plausible JSON. Doing it properly means
 * `withCount()`, a cast the type definitions do not model, a ceiling on the
 * limit, and `hasMore` arithmetic, in every list endpoint you write.
 *
 * **Sort the query yourself.** Which order a list is in belongs to the
 * endpoint, and this never chooses it for you.
 *
 * That the order is *total* is this function's job, and it is handled: a
 * `createdAt` tiebreaker is appended to whatever you sorted by, so ties are
 * settled and pages are stable. Without that, an unsorted list — or one sorted
 * by a column with repeated values — silently repeats and drops rows as data
 * changes. Pass `{tiebreak: false}` to opt out; see `PaginateOptions`.
 *
 * The limit is capped at `maxLimit`. Without a ceiling, `?limit=999999` is a
 * denial of service anybody can type into a browser.
 */
export async function paginate<T = Parse.Object>(
  query: Parse.Query,
  params: PageParams = {},
  options: PaginateOptions = {}
): Promise<Page<T>> {
  const {
    defaultLimit = 20,
    maxLimit = MAX_QUERY_LIMIT,
    useMasterKey,
    sessionToken,
    tiebreak = true,
  } = options;

  const limit = Math.min(toPositiveInt(params.limit, defaultLimit) || defaultLimit, maxLimit);
  const skip = toPositiveInt(params.skip, 0);

  query.limit(limit).skip(skip);

  /*
   * A tiebreaker, appended rather than imposed.
   *
   * Paging needs a TOTAL order. Without one the database is free to return rows
   * in any order it likes, so a row can appear on two pages or on none as data
   * changes underneath — and nothing errors.
   *
   * "Always sort" is not enough advice, because sorting by a low-cardinality
   * column does not help: a hundred rows all with status 'draft' tie with each
   * other, and ties are exactly as unstable as no sort at all. That case is
   * invisible, and nobody thinks to look for it.
   *
   * `addDescending` appends, so it never overrides the caller's order — it only
   * settles what the caller's order leaves undecided. Choosing WHICH order a
   * list is in stays the endpoint's business; guaranteeing the order is total
   * is this function's.
   */
  if (tiebreak) query.addDescending('createdAt');

  /*
   * `withCount()` returns the total alongside the page, in one round trip. The
   * alternative — a second `count()` query — costs two trips and can disagree
   * with the first under concurrent writes, which shows up as a page count
   * that flickers.
   */
  query.withCount();

  const findOptions: Record<string, unknown> = {};
  if (useMasterKey) findOptions.useMasterKey = true;
  if (sessionToken) findOptions.sessionToken = sessionToken;

  /*
   * The cast is unavoidable. `withCount()` changes what `find()` resolves to —
   * `{results, count}` rather than an array — and neither @types/parse nor the
   * SDK's own definitions model that.
   */
  const page = (await query.find(findOptions)) as unknown as {
    results?: unknown[];
    count?: number;
  };

  /*
   * Defensive, because this shape comes from a cast rather than from the type
   * system. If a future SDK stops honouring `withCount` and returns a plain
   * array, fall back to it rather than answering with `undefined` results —
   * the count is then wrong, but the endpoint still returns its rows.
   */
  const results = (Array.isArray(page) ? page : (page.results ?? [])) as T[];
  const count = typeof page.count === 'number' ? page.count : results.length;

  return {
    results,
    count,
    limit,
    skip,
    hasMore: skip + results.length < count,
  };
}
