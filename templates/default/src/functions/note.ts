import {CloudFunction, Route, catchError, paginate} from 'parse-server-kit';
import Note from '../models/Note';
import {Roles} from '../roles';

/**
 * The method name IS the route.
 *
 *   createNote → POST /api/notes/createNote
 *   listNotes  → GET  /api/notes/listNotes
 *
 * `@Route(Note)` turns the class name into the `notes` prefix; each method name
 * becomes the action. Renaming a method renames its route, and there is no
 * route table to keep in step.
 */
@Route(Note)
class NoteFunctions {
  @CloudFunction({
    methods: ['POST'],
    description: 'Create a note',
    validation: {requireUser: true, fields: {title: {required: true}}},
    swagger: {tags: ['Notes']},
  })
  static async createNote(req: Parse.Cloud.FunctionRequest) {
    // Reads @ParseField metadata to build a typed instance — converting
    // pointers, dates and geopoints — instead of a pile of set() calls.
    const note = Note.fromParams(req.params);

    const [err, saved] = await catchError(
      note.save(null, {sessionToken: req.user!.getSessionToken()})
    );
    if (err) throw err;
    return saved;
  }

  @CloudFunction({
    methods: ['GET'],
    description: 'List notes, newest first, paginated',
    // GET params arrive as STRINGS — the query string is merged into the body.
    validation: {
      fields: {limit: {type: String}, skip: {type: String}, status: {type: String}},
    },
    swagger: {tags: ['Notes']},
  })
  static async listNotes(req: Parse.Cloud.FunctionRequest) {
    const query = new Parse.Query(Note);
    if (req.params.status) query.equalTo('status', req.params.status);

    /*
     * Order it, and order it by something stable.
     *
     * Pagination over an unsorted query is not stable: MongoDB guarantees no
     * order without a sort, so as rows are written a record can appear on two
     * pages or on none. Nothing errors; the list is just quietly wrong.
     * `paginate` deliberately does not choose an order for you, because the
     * right one belongs to the endpoint.
     */
    query.descending('createdAt');

    /*
     * `paginate` caps the limit, reads limit/skip as the strings a GET sends,
     * asks for the TOTAL rather than the page size, and works out `hasMore`.
     *
     * The version people write by hand returns `results.length` as the count —
     * the size of the page you already have, which no client can paginate
     * with — and it runs perfectly while doing so.
     */
    return paginate<Note>(query, req.params, {useMasterKey: true});
  }

  @CloudFunction({
    methods: ['GET'],
    description: 'Fetch one note by id',
    validation: {fields: {id: {type: String, required: true}}},
    swagger: {tags: ['Notes']},
  })
  static async getNote(req: Parse.Cloud.FunctionRequest) {
    const [err, note] = await catchError(
      new Parse.Query(Note).get(req.params.id, {useMasterKey: true})
    );
    if (err) throw err;
    return note as Note;
  }

  @CloudFunction({
    methods: ['POST'],
    description: 'Update a note',
    // Editing someone else's note is a privileged act, so it is gated the same
    // way the model's CLP gates it. Both checks are worth having: this one
    // refuses the call, the CLP refuses the write.
    requiresAuth: true,
    requireRoles: [Roles.EDITOR],
    validation: {requireUser: true, fields: {id: {required: true}}},
    swagger: {tags: ['Notes']},
  })
  static async updateNote(req: Parse.Cloud.FunctionRequest) {
    const note = Note.fromParams(req.params);
    const [err, saved] = await catchError(
      note.save(null, {sessionToken: req.user!.getSessionToken()})
    );
    if (err) throw err;
    return saved;
  }

  /**
   * Deleting is the destructive one, so it is the one that shows the rest of
   * what `@CloudFunction` accepts:
   *
   *   requiresAuth          refuse anyone without a session. Enforced before
   *                         your body runs; a master-key call still passes.
   *   requireRoles          refuse anyone outside these roles. ANY of them by
   *                         default; add `requireAllRoles: true` to demand all.
   *   customErrorMessage    what the caller sees instead of the default
   *                         "Access denied. Required one of these roles: ...".
   *   rateLimit             a token bucket, per process. Applies whether the
   *                         caller comes through this route or straight at
   *                         /functions/deleteNote.
   *
   * Add `@Transactional()` BELOW `@CloudFunction` — never above — when a
   * function writes more than once and the writes must land together.
   * Decorators apply bottom-up, so reversed, the registry keeps the unwrapped
   * method and the transaction never opens, with no error.
   */
  @CloudFunction({
    methods: ['POST'],
    description: 'Delete a note',
    requiresAuth: true,
    requireRoles: [Roles.EDITOR],
    customErrorMessage: 'Only an Editor may delete a note.',
    rateLimit: {windowMs: 60_000, max: 20},
    validation: {requireUser: true, fields: {id: {required: true}}},
    swagger: {tags: ['Notes']},
  })
  static async deleteNote(req: Parse.Cloud.FunctionRequest) {
    const [findErr, note] = await catchError(
      new Parse.Query(Note).get(req.params.id, {useMasterKey: true})
    );
    if (findErr) throw findErr;

    const [delErr] = await catchError(note!.destroy({useMasterKey: true}));
    if (delErr) throw delErr;

    return {deleted: true, id: req.params.id};
  }
}

export default NoteFunctions;
