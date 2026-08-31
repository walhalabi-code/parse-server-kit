import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import './env';

/*
 * `require`, not `import`.
 *
 * The SDK has to be on the global before a model is imported, because
 * `@ParseClass` registers the subclass while the module is being evaluated.
 *
 * A typed `import Parse from 'parse/node'` would do that too — but it also
 * pulls in the type definitions the `parse` package ships, which disagree with
 * `@types/parse` that the rest of the project uses. `getSessionToken()` is
 * `string` in one and `string | null` in the other, and having both in a
 * project produces errors that point at your code rather than at the clash.
 *
 * Requiring it sets the global without introducing a second source of types,
 * so `Parse` here means the same thing it means everywhere else.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
(global as unknown as {Parse: unknown}).Parse = require('parse/node');

import Note from './models/Note';

/**
 * A starting point for this project's tests.
 *
 * Run with `npm test`. It uses Node's own test runner, so there is nothing to
 * install and no config file — the same reason this project has no runtime
 * dependencies of its own beyond what Parse needs.
 *
 * Nothing here touches the database. These are the checks worth having before
 * anything else, because the mistakes they catch are the ones that raise no
 * error at runtime: a field that silently never reaches Parse, and a validation
 * rule that is declared but not enforced.
 *
 * When you want tests that DO hit the database, the docker-compose file in this
 * project already gives you a MongoDB replica set — the hard part.
 */

describe('the Note model', () => {
  test('a field written on the instance reaches Parse', () => {
    const note = new Note();
    note.title = 'Hello';

    // Both must agree. If `title` were declared `title!: string` instead of
    // `declare title: string`, the emitted class field would shadow the
    // accessor @ParseField installs — the first assertion would still pass
    // while the second returned undefined, and save() would send nothing.
    assert.equal(note.title, 'Hello');
    assert.equal(note.get('title'), 'Hello');
  });

  test('what save() would send actually contains the field', () => {
    const note = new Note();
    note.title = 'Hello';
    note.slug = 'hello';

    // toJSON is the payload. A field missing here is a field the database
    // never sees, however correct the property looks.
    assert.ok(Object.keys(note.toJSON()).includes('title'));
    assert.ok(Object.keys(note.toJSON()).includes('slug'));
  });

  test('the class registers under its Parse name', () => {
    const row = Parse.Object.fromJSON({className: 'Note'} as never, true);
    assert.ok(row instanceof Note);
  });

  test('the beforeSave trigger derives a slug from the title', async () => {
    const note = new Note();
    note.title = 'My First Note';

    await Note.onBeforeSave({object: note} as never);

    assert.equal(note.slug, 'my-first-note');
    assert.equal(note.status, 'draft', 'status should default');
    assert.equal(note.views, 0, 'views should default');
  });

  test('validation rejects what the schema forbids', async () => {
    const note = new Note();
    note.title = '';               // required, minLength 1
    note.status = 'nonsense';      // not in the enum

    await assert.rejects(
      () => Note.onBeforeSave({object: note} as never),
      (error: unknown) => error instanceof Parse.Error,
      'an invalid note should not save'
    );
  });
});
