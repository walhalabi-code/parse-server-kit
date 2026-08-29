import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {
  OPTIONS_ARGUMENT,
  withAmbientSession,
} from '../../src/transactions/ambientSession';
import {
  useTransactionAdapter,
  withTransaction,
} from '../../src/transactions/context';

/* eslint-disable @typescript-eslint/no-var-requires */
// The driver parse-server actually ships — resolved from its dependency tree,
// NOT pinned by this repo. That is the whole point: when parse-server upgrades
// its driver, these tests re-verify OPTIONS_ARGUMENT against the new one.
const {MongoClient} = (() => {
  try {
    return require('parse-server/node_modules/mongodb');
  } catch {
    return require('mongodb');
  }
})();

type AnyRecord = Record<string, any>;

/**
 * `OPTIONS_ARGUMENT` claims, for every driver method Parse Server calls, which
 * argument position the driver reads its options from. Verified here against
 * the real driver: each method is called through `withAmbientSession` inside an
 * ambient session, and the resulting wire command must carry that session's
 * `lsid` — which can only happen if the injected `{session}` object landed in
 * the position the driver treats as options.
 */

/** How to invoke each allowlisted method with minimal, valid arguments. */
const INVOCATIONS: Record<
  string,
  {command: string; invoke: (collection: AnyRecord) => Promise<unknown>}
> = {
  insertOne: {command: 'insert', invoke: c => c.insertOne({probe: 1})},
  insertMany: {command: 'insert', invoke: c => c.insertMany([{probe: 1}])},
  updateOne: {command: 'update', invoke: c => c.updateOne({probe: 1}, {$set: {touched: true}})},
  updateMany: {command: 'update', invoke: c => c.updateMany({probe: 1}, {$set: {touched: true}})},
  replaceOne: {command: 'update', invoke: c => c.replaceOne({probe: 1}, {probe: 1, replaced: true})},
  findOneAndUpdate: {command: 'findAndModify', invoke: c => c.findOneAndUpdate({probe: 1}, {$set: {touched: true}})},
  findOneAndDelete: {command: 'findAndModify', invoke: c => c.findOneAndDelete({probe: 999})},
  deleteOne: {command: 'delete', invoke: c => c.deleteOne({probe: 999})},
  deleteMany: {command: 'delete', invoke: c => c.deleteMany({probe: 999})},
  find: {command: 'find', invoke: c => c.find({probe: 1}).toArray()},
  findOne: {command: 'find', invoke: c => c.findOne({probe: 1})},
  aggregate: {command: 'aggregate', invoke: c => c.aggregate([{$match: {probe: 1}}]).toArray()},
  countDocuments: {command: 'aggregate', invoke: c => c.countDocuments({probe: 1})},
  distinct: {command: 'distinct', invoke: c => c.distinct('probe', {})},
};

let replSet: MongoMemoryReplSet;
let client: any;
let commands: Array<{commandName: string; command: AnyRecord}> = [];

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({replSet: {count: 1}});
  client = new MongoClient(replSet.getUri(), {monitorCommands: true});
  client.on('commandStarted', (event: {commandName: string; command: AnyRecord}) => {
    commands.push({commandName: event.commandName, command: event.command});
  });
  await client.connect();
});

afterAll(async () => {
  await client?.close();
  await replSet?.stop();
});

function sessionId(session: AnyRecord): string {
  return Buffer.from(session.id.id.buffer).toString('base64');
}

function commandSessionId(command: AnyRecord): string | undefined {
  const lsid = command.lsid as {id?: {buffer: Uint8Array}} | undefined;
  return lsid?.id && Buffer.from(lsid.id.buffer).toString('base64');
}

describe('OPTIONS_ARGUMENT positions against the shipped driver', () => {
  it('covers every allowlisted method with an invocation', () => {
    expect(Object.keys(INVOCATIONS).sort()).toEqual(Object.keys(OPTIONS_ARGUMENT).sort());
  });

  // A bare session (no transaction), so even the methods MongoDB refuses to
  // run transactionally — `distinct` — still verify their argument position.
  describe.each(Object.keys(OPTIONS_ARGUMENT))('%s', method => {
    it('sends the ambient session, so the options index is right', async () => {
      const raw = client.db('positions').collection('probe');
      await raw.insertOne({probe: 1}); // seed so reads have something to do
      const wrapped = withAmbientSession(raw as unknown as AnyRecord);

      let session: AnyRecord | undefined;
      useTransactionAdapter({
        connect: async () => undefined,
        createTransactionalSession: async () => {
          session = client.startSession();
          return session;
        },
        commitTransactionalSession: async s => (s as AnyRecord).endSession(),
        abortTransactionalSession: async s => (s as AnyRecord).endSession(),
      });

      commands = [];
      await withTransaction(async () => {
        await INVOCATIONS[method].invoke(wrapped);
      });

      const sent = commands.filter(
        c => c.commandName === INVOCATIONS[method].command
      );
      expect(sent.length).toBeGreaterThan(0);
      for (const {command} of sent) {
        expect(commandSessionId(command)).toBe(sessionId(session!));
      }
    });
  });
});

describe('real transactions through the ambient session', () => {
  beforeEach(() => {
    useTransactionAdapter({
      connect: async () => undefined,
      createTransactionalSession: async () => {
        const session = client.startSession();
        session.startTransaction();
        return session;
      },
      commitTransactionalSession: async s => {
        const session = s as AnyRecord;
        await session.commitTransaction();
        await session.endSession();
      },
      abortTransactionalSession: async s => {
        const session = s as AnyRecord;
        await session.abortTransaction();
        await session.endSession();
      },
    });
  });

  it('marks the commands as transactional on the wire', async () => {
    const raw = client.db('txn').collection('wire');
    await raw.insertOne({seed: true});
    const wrapped = withAmbientSession(raw as unknown as AnyRecord);

    commands = [];
    await withTransaction(async () => {
      await wrapped.insertOne({inTxn: true});
    });

    const insert = commands.find(c => c.commandName === 'insert');
    expect(insert).toBeDefined();
    expect(insert!.command.autocommit).toBe(false);
    expect(insert!.command.txnNumber).toBeDefined();
  });

  it('a thrown body rolls every write back', async () => {
    const raw = client.db('txn').collection('rollback');
    await raw.insertOne({seed: true}); // collection must exist beforehand
    const wrapped = withAmbientSession(raw as unknown as AnyRecord);

    await expect(
      withTransaction(async () => {
        await wrapped.insertOne({doomed: 1});
        await wrapped.insertOne({doomed: 2});
        throw new Error('roll it all back');
      })
    ).rejects.toThrow('roll it all back');

    expect(await raw.countDocuments({doomed: {$exists: true}})).toBe(0);
  });

  it('a completed body commits every write', async () => {
    const raw = client.db('txn').collection('commit');
    await raw.insertOne({seed: true});
    const wrapped = withAmbientSession(raw as unknown as AnyRecord);

    await withTransaction(async () => {
      await wrapped.insertOne({kept: 1});
      await wrapped.insertOne({kept: 2});
    });

    expect(await raw.countDocuments({kept: {$exists: true}})).toBe(2);
  });

  it('reads inside the transaction see its own uncommitted writes; outside reads do not', async () => {
    const raw = client.db('txn').collection('visibility');
    await raw.insertOne({seed: true});
    const wrapped = withAmbientSession(raw as unknown as AnyRecord);

    await withTransaction(async () => {
      await wrapped.insertOne({phantom: true});
      const inside = (await wrapped.find({phantom: true}).toArray()) as unknown[];
      expect(inside).toHaveLength(1);

      // The raw, unwrapped collection reads outside the snapshot.
      expect(await raw.countDocuments({phantom: true})).toBe(0);
      await wrapped.deleteMany({phantom: true});
    });
  });
});
