/**
 * Endpoints for the smoke suite: routing, role gating, GET-parameter handling
 * and a transaction with the decorator pair in the correct order.
 */
import {
  Route,
  CloudFunction,
  Transactional,
  catchError,
  MAX_QUERY_LIMIT,
} from '../../src';
import {SmokeWidget, SmokeLedger} from './models';

/** Set by the transaction tests so assertions can see how often a body ran. */
export const callLog = {transactionAttempts: 0};

@Route(SmokeWidget)
export class SmokeWidgetFunctions {
  @CloudFunction({
    methods: ['POST'],
    description: 'Create a widget',
    swagger: {tags: ['Smoke']},
  })
  static async createSmokeWidget(req: Parse.Cloud.FunctionRequest) {
    const widget = SmokeWidget.fromParams(req.params);
    const [err, saved] = await catchError(widget.save(null, {useMasterKey: true}));
    if (err) throw err;
    return saved;
  }

  @CloudFunction({
    methods: ['GET'],
    description: 'List widgets',
    // GET params arrive as strings; this proves the conversion is the caller's
    // job and that the merge from the query string happened at all.
    validation: {fields: {limit: {type: String}, status: {type: String}}},
    swagger: {tags: ['Smoke']},
  })
  static async listSmokeWidgets(req: Parse.Cloud.FunctionRequest) {
    const query = new Parse.Query(SmokeWidget);
    const limit = Math.min(Number(req.params.limit) || 20, MAX_QUERY_LIMIT);
    query.limit(limit);
    if (req.params.status) query.equalTo('status', req.params.status);

    const [err, rows] = await catchError(query.find({useMasterKey: true}));
    if (err) throw err;

    return {
      count: rows!.length,
      limitWasString: typeof req.params.limit === 'string',
      results: rows as SmokeWidget[],
    };
  }

  @CloudFunction({
    methods: ['POST'],
    description: 'Requires a role nobody has',
    requireRoles: ['NobodyHasThisRole'],
    swagger: {tags: ['Smoke']},
  })
  static async gatedSmokeWidget() {
    return {reached: true};
  }

  @CloudFunction({
    methods: ['POST'],
    description: 'Requires a signed-in user',
    validation: {requireUser: true},
    swagger: {tags: ['Smoke']},
  })
  static async authedSmokeWidget() {
    return {reached: true};
  }

  /**
   * Declares `requiresAuth` and NOTHING else.
   *
   * The question this answers: does the top-level `requiresAuth` flag actually
   * gate the endpoint, or is it only read by the Swagger renderer? If an
   * anonymous caller reaches the body, the flag is decorative — and it sits one
   * character away from `requireUser`, which does work.
   */
  @CloudFunction({
    methods: ['POST'],
    description: 'Claims to require auth via the top-level flag',
    requiresAuth: true,
    swagger: {tags: ['Smoke']},
  })
  static async requiresAuthOnlyWidget() {
    return {reached: true};
  }

  /**
   * GET-only and rate limited to two calls.
   *
   * Both are enforced by validateEntityRoutes, which only runs for a registered
   * entity prefix. Calling /functions/{name} directly is the question: does it
   * skip them?
   */
  @CloudFunction({
    methods: ['GET'],
    description: 'GET only, for testing the method check',
    swagger: {tags: ['Smoke']},
  })
  static async limitedSmokeWidget() {
    return {reached: true};
  }

  /**
   * POST and rate limited, so the limiter is what the test exercises.
   *
   * Kept separate from the GET-only one above: with the method check now
   * running first, a POST there returns 405 and the limiter is never reached —
   * which would test the wrong thing.
   */
  @CloudFunction({
    methods: ['POST'],
    description: 'Two calls per minute',
    rateLimit: {windowMs: 60000, max: 2},
    swagger: {tags: ['Smoke']},
  })
  static async limitedPostWidget() {
    return {reached: true};
  }

  /**
   * Two writes in one transaction. `shouldFail` makes the body throw after the
   * first write, so the assertion can check nothing was left behind.
   *
   * @CloudFunction ABOVE, @Transactional BELOW — reversed, the registry keeps
   * the unwrapped method and the transaction never opens.
   */
  @CloudFunction({methods: ['POST'], swagger: {tags: ['Smoke']}})
  @Transactional()
  static async smokeTransfer(req: Parse.Cloud.FunctionRequest) {
    callLog.transactionAttempts += 1;

    const first = new SmokeLedger();
    first.note = req.params.note + '-1';
    await first.save(null, {useMasterKey: true});

    if (req.params.shouldFail === 'true') {
      throw new Parse.Error(141, 'deliberate failure after the first write');
    }

    const second = new SmokeLedger();
    second.note = req.params.note + '-2';
    await second.save(null, {useMasterKey: true});

    return {ok: true};
  }
}
