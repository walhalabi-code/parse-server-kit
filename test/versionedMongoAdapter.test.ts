import 'reflect-metadata';

/**
 * `createVersionedMongoAdapter` — the enforcement side of optimistic locking,
 * plus the ambient-transaction plumbing.
 *
 * parse-server itself is not a dependency of this repo; the adapter requires
 * its Mongo adapter lazily, so the module is mocked (virtually) with a base
 * class that records what reaches it.
 */

const mockFindOneAndUpdate = jest.fn();
const mockCreateObject = jest.fn();
const mockFind = jest.fn();
const mockAdaptiveCollection = jest.fn();
const mockCreateSession = jest.fn();

jest.mock(
  'parse-server/lib/Adapters/Storage/Mongo/MongoStorageAdapter',
  () => ({
    MongoStorageAdapter: class {
      options: unknown;
      constructor(options: unknown) {
        this.options = options;
      }
      connect() {
        return Promise.resolve();
      }
      createTransactionalSession() {
        return mockCreateSession();
      }
      commitTransactionalSession() {
        return Promise.resolve();
      }
      abortTransactionalSession() {
        return Promise.resolve();
      }
      findOneAndUpdate(...args: unknown[]) {
        return mockFindOneAndUpdate(...args);
      }
      createObject(...args: unknown[]) {
        return mockCreateObject(...args);
      }
      find(...args: unknown[]) {
        return mockFind(...args);
      }
      _adaptiveCollection(...args: unknown[]) {
        return mockAdaptiveCollection(...args);
      }
    },
  }),
  {virtual: true}
);

import {ParseClass} from '../src/decorators/parseDecorators';
import {ParseVersionField} from '../src/database/versionRegistry';
import {
  createVersionedMongoAdapter,
  VERSION_CONFLICT,
  VERSION_CONFLICT_MESSAGE,
} from '../src/database/versionedMongoAdapter';
import {withTransaction} from '../src/transactions/context';

@ParseClass('VMDoc')
class VMDoc extends Parse.Object {
  constructor() {
    super('VMDoc');
  }

  @ParseVersionField()
  version!: number;
}
void VMDoc;

const SCHEMA = {marker: 'schema'};

function makeAdapter() {
  return createVersionedMongoAdapter({uri: 'mongodb://example'});
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateSession.mockImplementation(async () => ({kind: 'session'}));
});

describe('construction', () => {
  it('hands its options to the base adapter', () => {
    const adapter = makeAdapter() as unknown as {options: unknown};
    expect(adapter.options).toEqual({uri: 'mongodb://example'});
  });
});

describe('findOneAndUpdate on an unversioned class', () => {
  it('passes everything through untouched', async () => {
    mockFindOneAndUpdate.mockResolvedValue({ok: true});
    const adapter = makeAdapter();
    const session = {};

    const result = await adapter.findOneAndUpdate(
      'PlainClass',
      SCHEMA,
      {objectId: 'a1'},
      {name: 'x'},
      session
    );

    expect(result).toEqual({ok: true});
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      'PlainClass',
      SCHEMA,
      {objectId: 'a1'},
      {name: 'x'},
      session
    );
  });
});

describe('findOneAndUpdate on a versioned class', () => {
  it('moves the asserted version into the filter and swaps in an increment', async () => {
    mockFindOneAndUpdate.mockResolvedValue({updated: true});
    const adapter = makeAdapter();

    const result = await adapter.findOneAndUpdate(
      'VMDoc',
      SCHEMA,
      {objectId: 'a1'},
      {name: 'x', version: 4}
    );

    expect(result).toEqual({updated: true});
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      'VMDoc',
      SCHEMA,
      {objectId: 'a1', version: 4},
      {name: 'x', version: {__op: 'Increment', amount: 1}},
      undefined
    );
    // The row was found at the asserted version — no existence probe needed.
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('reports a lost race as the shared conflict error', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null); // filter matched nothing
    mockFind.mockResolvedValue([{objectId: 'a1'}]); // ...but the row is there
    const adapter = makeAdapter();

    await expect(
      adapter.findOneAndUpdate('VMDoc', SCHEMA, {objectId: 'a1'}, {version: 3})
    ).rejects.toMatchObject({
      code: VERSION_CONFLICT,
      message: VERSION_CONFLICT_MESSAGE,
    });

    // Existence is probed with the caller's original, unversioned query.
    expect(mockFind).toHaveBeenCalledWith('VMDoc', SCHEMA, {objectId: 'a1'}, {limit: 1});
  });

  it('lets a genuinely missing row read as missing, not as a conflict', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    mockFind.mockResolvedValue([]);
    const adapter = makeAdapter();

    await expect(
      adapter.findOneAndUpdate('VMDoc', SCHEMA, {objectId: 'gone'}, {version: 3})
    ).resolves.toBeNull();
  });

  it('still moves the version on when the save asserts nothing', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    const adapter = makeAdapter();

    // No version in the update — an unread object, or a master-key script.
    const result = await adapter.findOneAndUpdate(
      'VMDoc',
      SCHEMA,
      {objectId: 'a1'},
      {name: 'x'}
    );

    expect(result).toBeNull(); // a miss is a miss — no conflict conjured up
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      'VMDoc',
      SCHEMA,
      {objectId: 'a1'}, // filter untouched
      {name: 'x', version: {__op: 'Increment', amount: 1}},
      undefined
    );
  });

  it('treats an operator on the version field as no assertion', async () => {
    mockFindOneAndUpdate.mockResolvedValue({updated: true});
    const adapter = makeAdapter();

    await adapter.findOneAndUpdate(
      'VMDoc',
      SCHEMA,
      {objectId: 'a1'},
      {version: {__op: 'Delete'}}
    );

    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      'VMDoc',
      SCHEMA,
      {objectId: 'a1'},
      {version: {__op: 'Increment', amount: 1}},
      undefined
    );
  });
});

describe('createObject', () => {
  it('gives a versioned row its first version', async () => {
    mockCreateObject.mockResolvedValue({ops: []});
    const adapter = makeAdapter();

    await adapter.createObject('VMDoc', SCHEMA, {name: 'fresh'});

    expect(mockCreateObject).toHaveBeenCalledWith(
      'VMDoc',
      SCHEMA,
      {name: 'fresh', version: 1},
      undefined
    );
  });

  it('respects a version the caller supplied — imports keep their history', async () => {
    mockCreateObject.mockResolvedValue({ops: []});
    const adapter = makeAdapter();

    await adapter.createObject('VMDoc', SCHEMA, {name: 'imported', version: 7});

    expect(mockCreateObject).toHaveBeenCalledWith(
      'VMDoc',
      SCHEMA,
      {name: 'imported', version: 7},
      undefined
    );
  });

  it('leaves unversioned classes untouched', async () => {
    mockCreateObject.mockResolvedValue({ops: []});
    const adapter = makeAdapter();
    const object = {name: 'plain'};

    await adapter.createObject('PlainClass', SCHEMA, object);

    expect(mockCreateObject.mock.calls[0][2]).toBe(object); // same reference
  });
});

describe('_adaptiveCollection and the ambient transaction', () => {
  it('wraps ordinary collections so their calls join the ambient session', async () => {
    const rawCollection = {find: jest.fn().mockReturnValue('cursor')};
    mockAdaptiveCollection.mockResolvedValue({_mongoCollection: rawCollection});
    const adapter = makeAdapter(); // registers itself as the transaction adapter

    const collection = await adapter._adaptiveCollection('VMDoc');
    expect(collection._mongoCollection).not.toBe(rawCollection);

    await withTransaction(async () => {
      (collection._mongoCollection as {find: (...a: unknown[]) => unknown}).find({a: 1});
    });

    expect(rawCollection.find).toHaveBeenCalledWith(
      {a: 1},
      {session: {kind: 'session'}}
    );
  });

  it('never drags the shielded system classes into a transaction', async () => {
    const rawCollection = {insertOne: jest.fn()};
    mockAdaptiveCollection.mockResolvedValue({_mongoCollection: rawCollection});
    const adapter = makeAdapter();

    const collection = await adapter._adaptiveCollection('_SCHEMA');
    expect(collection._mongoCollection).toBe(rawCollection);
  });

  it('registers itself as the transaction adapter for withTransaction', async () => {
    makeAdapter();
    await withTransaction(async () => undefined);
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });
});
