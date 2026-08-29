import type {TransactionalAdapter} from '../src/transactions/context';

/**
 * `withTransaction` / `@Transactional` — session lifecycle, retry policy,
 * nesting, and isolation between concurrent calls.
 *
 * The module keeps its adapter in module state, so each test gets a fresh
 * require of the module.
 */

type ContextModule = typeof import('../src/transactions/context');

interface FakeAdapter extends TransactionalAdapter {
  sessions: object[];
  connect: jest.Mock;
  createTransactionalSession: jest.Mock;
  commitTransactionalSession: jest.Mock;
  abortTransactionalSession: jest.Mock;
}

function fakeAdapter(): FakeAdapter {
  const sessions: object[] = [];
  return {
    sessions,
    connect: jest.fn().mockResolvedValue(undefined),
    createTransactionalSession: jest.fn().mockImplementation(async () => {
      const session = {n: sessions.length};
      sessions.push(session);
      return session;
    }),
    commitTransactionalSession: jest.fn().mockResolvedValue(undefined),
    abortTransactionalSession: jest.fn().mockResolvedValue(undefined),
  };
}

let ctx: ContextModule;
let adapter: FakeAdapter;

beforeEach(() => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ctx = require('../src/transactions/context');
  adapter = fakeAdapter();
});

describe('withTransaction without an adapter', () => {
  it('still runs the body, and warns exactly once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(ctx.withTransaction(async () => 'first')).resolves.toBe('first');
      await expect(ctx.withTransaction(async () => 'second')).resolves.toBe('second');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/No storage adapter registered/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('withTransaction with an adapter', () => {
  beforeEach(() => ctx.useTransactionAdapter(adapter));

  it('connects, opens a session, runs the body inside it, commits', async () => {
    const result = await ctx.withTransaction(async () => {
      expect(ctx.inTransaction()).toBe(true);
      expect(ctx.currentSession()).toBe(adapter.sessions[0]);
      return 42;
    });

    expect(result).toBe(42);
    expect(adapter.connect).toHaveBeenCalled();
    expect(adapter.createTransactionalSession).toHaveBeenCalledTimes(1);
    expect(adapter.commitTransactionalSession).toHaveBeenCalledWith(adapter.sessions[0]);
    expect(adapter.abortTransactionalSession).not.toHaveBeenCalled();
  });

  it('leaves no session behind once the body is done', async () => {
    await ctx.withTransaction(async () => undefined);
    expect(ctx.inTransaction()).toBe(false);
    expect(ctx.currentSession()).toBeUndefined();
  });

  it('a nested call joins the outer transaction instead of opening its own', async () => {
    await ctx.withTransaction(async () => {
      const outer = ctx.currentSession();
      await ctx.withTransaction(async () => {
        expect(ctx.currentSession()).toBe(outer);
      });
    });

    expect(adapter.createTransactionalSession).toHaveBeenCalledTimes(1);
    expect(adapter.commitTransactionalSession).toHaveBeenCalledTimes(1);
  });

  it('two concurrent calls each get their own session', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));

    const seen: unknown[] = [];
    const first = ctx.withTransaction(async () => {
      seen.push(ctx.currentSession());
      await gate; // hold the transaction open while the second one runs
    });
    const second = ctx.withTransaction(async () => {
      seen.push(ctx.currentSession());
      release();
    });

    await Promise.all([first, second]);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBeDefined();
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('aborts and rethrows a non-transient error without retrying', async () => {
    const failure = new Error('business rule violated');
    await expect(
      ctx.withTransaction(async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(adapter.createTransactionalSession).toHaveBeenCalledTimes(1);
    expect(adapter.abortTransactionalSession).toHaveBeenCalledWith(adapter.sessions[0]);
    expect(adapter.commitTransactionalSession).not.toHaveBeenCalled();
  });

  describe('retrying transient failures', () => {
    function transientByLabel(): Error {
      const error = new Error('write conflict') as Error & {
        hasErrorLabel: (label: string) => boolean;
      };
      error.hasErrorLabel = label => label === 'TransientTransactionError';
      return error;
    }

    it('re-runs the body after a TransientTransactionError label', async () => {
      let attempts = 0;
      const result = await ctx.withTransaction(async () => {
        attempts += 1;
        if (attempts === 1) throw transientByLabel();
        return 'made it';
      });

      expect(result).toBe('made it');
      expect(attempts).toBe(2);
      expect(adapter.createTransactionalSession).toHaveBeenCalledTimes(2);
      expect(adapter.abortTransactionalSession).toHaveBeenCalledTimes(1);
      expect(adapter.commitTransactionalSession).toHaveBeenCalledTimes(1);
    });

    it('treats MongoDB code 251 (NoSuchTransaction) as transient', async () => {
      let attempts = 0;
      await ctx.withTransaction(async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('aborted'), {code: 251});
      });
      expect(attempts).toBe(2);
    });

    it("treats Parse's opaque 'Database error' INTERNAL_SERVER_ERROR as transient", async () => {
      let attempts = 0;
      await ctx.withTransaction(async () => {
        attempts += 1;
        if (attempts === 1)
          throw new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'Database error');
      });
      expect(attempts).toBe(2);
    });

    it('does NOT retry an INTERNAL_SERVER_ERROR with any other message', async () => {
      const failure = new Parse.Error(Parse.Error.INTERNAL_SERVER_ERROR, 'disk on fire');
      await expect(
        ctx.withTransaction(async () => {
          throw failure;
        })
      ).rejects.toBe(failure);
      expect(adapter.createTransactionalSession).toHaveBeenCalledTimes(1);
    });

    it('gives up after 3 attempts with the shared CONFLICT error', async () => {
      let attempts = 0;
      const outcome = ctx.withTransaction(async () => {
        attempts += 1;
        throw transientByLabel();
      });

      await expect(outcome).rejects.toMatchObject({
        code: ctx.CONFLICT,
        message: ctx.CONFLICT_MESSAGE,
      });
      expect(attempts).toBe(3);
      expect(adapter.abortTransactionalSession).toHaveBeenCalledTimes(3);
      expect(adapter.commitTransactionalSession).not.toHaveBeenCalled();
    });

    it('retries when the COMMIT is what lost the race', async () => {
      adapter.commitTransactionalSession
        .mockRejectedValueOnce(transientByLabel())
        .mockResolvedValue(undefined);

      let attempts = 0;
      const result = await ctx.withTransaction(async () => {
        attempts += 1;
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(attempts).toBe(2);
      expect(adapter.commitTransactionalSession).toHaveBeenCalledTimes(2);
    });

    it('survives the abort itself failing', async () => {
      adapter.abortTransactionalSession.mockRejectedValue(new Error('session gone'));
      let attempts = 0;
      const result = await ctx.withTransaction(async () => {
        attempts += 1;
        if (attempts === 1) throw transientByLabel();
        return 'ok';
      });
      expect(result).toBe('ok');
    });
  });
});

describe('@Transactional', () => {
  beforeEach(() => ctx.useTransactionAdapter(adapter));

  it('wraps the method in withTransaction, keeping this and arguments', async () => {
    class Service {
      prefix = 'job:';

      @(ctx.Transactional())
      async submit(name: string): Promise<string> {
        expect(ctx.inTransaction()).toBe(true);
        return this.prefix + name;
      }
    }

    await expect(new Service().submit('alpha')).resolves.toBe('job:alpha');
    expect(adapter.commitTransactionalSession).toHaveBeenCalledTimes(1);
  });

  it('propagates the method result and errors through the transaction', async () => {
    class Service {
      @(ctx.Transactional())
      async explode(): Promise<never> {
        throw new Error('boom');
      }
    }

    await expect(new Service().explode()).rejects.toThrow('boom');
    expect(adapter.abortTransactionalSession).toHaveBeenCalledTimes(1);
  });

  it('refuses to decorate anything that is not a method', () => {
    expect(() =>
      ctx.Transactional()({}, 'field', {value: 42} as PropertyDescriptor)
    ).toThrow(/only be applied to methods/);
  });
});
