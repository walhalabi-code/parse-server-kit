import {CloudFunction, Route, catchError, MAX_QUERY_LIMIT} from 'parse-server-kit';
import Note from '../models/Note';

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
    description: 'List notes, newest first',
    // GET params arrive as STRINGS — the query string is merged into the body.
    validation: {
      fields: {limit: {type: String}, skip: {type: String}, status: {type: String}},
    },
    swagger: {tags: ['Notes']},
  })
  static async listNotes(req: Parse.Cloud.FunctionRequest) {
    const query = new Parse.Query(Note);

    const limit = Math.min(Number(req.params.limit) || 20, MAX_QUERY_LIMIT);
    query.limit(limit).skip(Number(req.params.skip) || 0);
    if (req.params.status) query.equalTo('status', req.params.status);

    const [err, results] = await catchError(query.find({useMasterKey: true}));
    if (err) throw err;

    // Cast — Parse.Query returns Parse.Object, not the typed class.
    return {results: results as Note[], count: results!.length};
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

  @CloudFunction({
    methods: ['POST'],
    description: 'Delete a note',
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
