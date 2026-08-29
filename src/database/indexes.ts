import 'reflect-metadata';
import {getSchemaDefinition} from '../decorators/parseDecorators';
import {classNames, CompoundIndex, IndexFieldType} from '../decorators/types/schemaTypes';
import {catchError} from '../utils/helper';

interface UniqueIndexInfo {
  className: string;
  field: string;
  indexName: string;
}

interface CompoundIndexInfo {
  className: string;
  fields: string[];
  indexName: string;
  unique: boolean;
  sparse: boolean;
  partialFilterNulls: boolean;
  fieldTypes?: Record<string, IndexFieldType>;
  options?: Record<string, unknown>;
}

interface FieldIndexInfo {
  className: string;
  field: string;
  indexName: string;
  /** 1/-1 for B-tree, or string for special types ('2dsphere', 'text', 'hashed'). */
  spec: IndexFieldType;
  options: Record<string, any>;
  /** Human-readable label for logs. */
  kind: 'ascending' | 'descending' | '2dsphere' | 'ttl' | 'text' | 'hashed';
}

/**
 * Get all unique indexes defined in models via @ParseField({ unique: true })
 */
export function getUniqueIndexes(): UniqueIndexInfo[] {
  const uniqueIndexes: UniqueIndexInfo[] = [];

  for (const className of classNames) {
    const classConstructor = Parse.Object.extend(className);
    const schema = getSchemaDefinition(classConstructor);

    if (schema.uniqueFields && schema.uniqueFields.length > 0) {
      for (const field of schema.uniqueFields) {
        uniqueIndexes.push({
          className: schema.className,
          field,
          indexName: `${field}_unique`,
        });
      }
    }
  }

  return uniqueIndexes;
}

/**
 * Get all compound indexes defined in models via @ParseClass({ compoundIndexes: [...] })
 */
export function getCompoundIndexes(): CompoundIndexInfo[] {
  const compoundIndexes: CompoundIndexInfo[] = [];

  for (const className of classNames) {
    const classConstructor = Parse.Object.extend(className);
    const schema = getSchemaDefinition(classConstructor);

    if (schema.compoundIndexes && schema.compoundIndexes.length > 0) {
      for (const compound of schema.compoundIndexes as CompoundIndex[]) {
        const suffix = compound.unique ? '_unique' : '_index';
        const indexName = compound.name || `${compound.fields.join('_')}${suffix}`;
        compoundIndexes.push({
          className: schema.className,
          fields: compound.fields,
          indexName,
          unique: compound.unique ?? false,
          sparse: compound.sparse ?? false,
          partialFilterNulls: compound.partialFilterNulls ?? false,
          fieldTypes: compound.fieldTypes,
          options: compound.options,
        });
      }
    }
  }

  return compoundIndexes;
}

/**
 * Get all single-field indexes defined via @ParseField:
 *   - { index: true | 1 | -1 } → B-tree (ascending/descending)
 *   - { geo: true } on GeoPoint → 2dsphere
 *   - { ttlSeconds: N } on Date → TTL
 *
 * Excludes unique indexes (handled by getUniqueIndexes).
 */
export function getFieldIndexes(): FieldIndexInfo[] {
  const result: FieldIndexInfo[] = [];

  for (const className of classNames) {
    const classConstructor = Parse.Object.extend(className);
    const fields: Record<string, any> =
      Reflect.getMetadata('parse:fields', classConstructor) || {};

    for (const [field, meta] of Object.entries(fields)) {
      // 2dsphere geo index
      if (meta.geo === true && meta.type === 'GeoPoint') {
        result.push({
          className,
          field,
          indexName: meta.indexName || `${field}_2dsphere`,
          spec: '2dsphere',
          options: {},
          kind: '2dsphere',
        });
        continue;
      }

      // TTL index
      if (meta.ttlSeconds !== undefined && meta.type === 'Date') {
        result.push({
          className,
          field,
          indexName: meta.indexName || `${field}_ttl`,
          spec: 1,
          options: {expireAfterSeconds: meta.ttlSeconds},
          kind: 'ttl',
        });
        continue;
      }

      // Non-unique single-field B-tree index
      // Skip if unique — that goes through getUniqueIndexes.
      if (meta.index && !meta.unique) {
        const spec: 1 | -1 = meta.index === -1 ? -1 : 1;
        result.push({
          className,
          field,
          indexName: meta.indexName || `${field}_index`,
          spec,
          options: {},
          kind: spec === -1 ? 'descending' : 'ascending',
        });
      }
    }
  }

  return result;
}

/**
 * Apply unique, compound, and single-field indexes (B-tree, 2dsphere, TTL) to MongoDB.
 * Call after Parse Server is initialized.
 */
export async function applyAllIndexes(parseServerInstance?: any): Promise<void> {
  const uniqueIndexes = getUniqueIndexes();
  const compoundIndexes = getCompoundIndexes();
  const fieldIndexes = getFieldIndexes();

  const totalIndexes = uniqueIndexes.length + compoundIndexes.length + fieldIndexes.length;
  if (totalIndexes === 0) {
    console.log('[Indexes] No indexes to apply');
    return;
  }

  console.log(
    `[Indexes] Applying ${uniqueIndexes.length} unique + ${compoundIndexes.length} compound + ${fieldIndexes.length} field index(es)...`
  );

  try {
    const config = parseServerInstance?.config;
    const adapter = config?.databaseController?.adapter || config?.database?.adapter;
    const db = adapter?.database || adapter?.client?.db() || adapter?.mongoClient?.db();

    if (!db) {
      console.warn('[Indexes] Could not access database adapter.');
      logManualIndexCommands(uniqueIndexes, compoundIndexes, fieldIndexes);
      return;
    }

    // Apply single-field unique indexes
    for (const {className, field, indexName} of uniqueIndexes) {
      const collection = db.collection(className);

      const [, existingIndexes] = await catchError<any[]>(collection.indexes());
      if (existingIndexes) {
        /*
         * Only a SINGLE-FIELD index on this field conflicts.
         *
         * The check used to be `idx.key[field] && !idx.unique`, which matches
         * any non-unique index merely CONTAINING the field — a compound index
         * included. So declaring `unique: true` on `status` alongside
         * `compoundIndexes: [{fields: ['status', 'createdAt']}]` dropped the
         * compound index on every boot. The later compound pass rebuilt it, so
         * the symptom was index churn and a window with no compound index
         * rather than an error — and an index created outside this library was
         * dropped for good.
         */
        const conflictingIndex = existingIndexes.find(
          (idx: any) =>
            idx.name !== '_id_' &&
            !idx.unique &&
            idx.key &&
            Object.keys(idx.key).length === 1 &&
            idx.key[field] !== undefined
        );
        if (conflictingIndex) {
          console.log(`[Indexes] Dropping non-unique index: ${conflictingIndex.name}`);
          await catchError(collection.dropIndex(conflictingIndex.name));
        }
      }

      const [createErr] = await catchError(
        collection.createIndex({[field]: 1}, {unique: true, name: indexName, background: true})
      );
      if (createErr) {
        if ((createErr as any).code === 85 || (createErr as any).code === 86) {
          console.log(`[Indexes] Index exists: ${className}.${field}`);
        } else {
          console.error(`[Indexes] Failed: ${className}.${field}:`, (createErr as any).message);
        }
      } else {
        console.log(`[Indexes] Created unique index: ${className}.${field}`);
      }
    }

    // Apply compound indexes
    for (const {className, fields, indexName, unique, sparse, partialFilterNulls, fieldTypes, options: extraOptions} of compoundIndexes) {
      const collection = db.collection(className);
      const keySpec: Record<string, IndexFieldType> = {};
      for (const field of fields) {
        keySpec[field] = fieldTypes?.[field] ?? 1;
      }

      const indexOptions: any = {unique, name: indexName, background: true};
      if (sparse) indexOptions.sparse = true;
      if (partialFilterNulls) {
        const partialFilter: Record<string, any> = {};
        for (const field of fields) partialFilter[field] = {$exists: true};
        indexOptions.partialFilterExpression = partialFilter;
      }
      if (extraOptions) Object.assign(indexOptions, extraOptions);

      const [compoundErr] = await catchError(collection.createIndex(keySpec, indexOptions));
      if (compoundErr) {
        if ((compoundErr as any).code === 85 || (compoundErr as any).code === 86) {
          console.log(`[Indexes] Index exists: ${className}.[${fields.join(', ')}]`);
        } else {
          console.error(`[Indexes] Failed: ${className}.[${fields.join(', ')}]:`, (compoundErr as any).message);
        }
      } else {
        const hasText = Object.values(keySpec).includes('text');
        const type = hasText ? 'text compound' : (unique ? 'unique compound' : 'compound');
        console.log(`[Indexes] Created ${type} index: ${className}.[${fields.join(', ')}]`);
      }
    }

    // Apply single-field non-unique indexes (B-tree, 2dsphere, TTL)
    for (const {className, field, indexName, spec, options: idxOptions, kind} of fieldIndexes) {
      const collection = db.collection(className);
      const createOptions: any = {name: indexName, background: true, ...idxOptions};

      const [createErr] = await catchError(
        collection.createIndex({[field]: spec} as Record<string, any>, createOptions)
      );
      if (createErr) {
        if ((createErr as any).code === 85 || (createErr as any).code === 86) {
          console.log(`[Indexes] Index exists: ${className}.${field}`);
        } else {
          console.error(`[Indexes] Failed: ${className}.${field}:`, (createErr as any).message);
        }
      } else {
        const ttlSuffix =
          kind === 'ttl' && idxOptions.expireAfterSeconds !== undefined
            ? ` (expireAfterSeconds=${idxOptions.expireAfterSeconds})`
            : '';
        console.log(`[Indexes] Created ${kind} index: ${className}.${field}${ttlSuffix}`);
      }
    }

    console.log('[Indexes] Complete');
  } catch (error: any) {
    console.error('[Indexes] Error:', error.message);
    logManualIndexCommands(uniqueIndexes, compoundIndexes, fieldIndexes);
  }
}

/**
 * Backward-compatible alias. Now applies all index kinds, not just unique.
 * @deprecated Use applyAllIndexes for clarity.
 */
export const applyUniqueIndexes = applyAllIndexes;

function logManualIndexCommands(
  uniqueIndexes: UniqueIndexInfo[],
  compoundIndexes: CompoundIndexInfo[] = [],
  fieldIndexes: FieldIndexInfo[] = []
): void {
  console.log('[Indexes] Manual MongoDB commands:');
  for (const {className, field, indexName} of uniqueIndexes) {
    console.log(`  db.${className}.createIndex({ ${field}: 1 }, { unique: true, name: "${indexName}" })`);
  }
  for (const {className, fields, indexName, unique, sparse, partialFilterNulls, fieldTypes, options} of compoundIndexes) {
    const keySpec = fields
      .map(f => {
        const v = fieldTypes?.[f] ?? 1;
        return typeof v === 'string' ? `${f}: "${v}"` : `${f}: ${v}`;
      })
      .join(', ');
    const opts = [
      `name: "${indexName}"`,
      unique && 'unique: true',
      sparse && 'sparse: true',
      partialFilterNulls && `partialFilterExpression: { ${fields.map(f => `${f}: { $exists: true }`).join(', ')} }`,
      options && Object.entries(options).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', '),
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`  db.${className}.createIndex({ ${keySpec} }, { ${opts} })`);
    if (Object.values(fieldTypes ?? {}).includes('text')) {
      console.log('    // Note: MongoDB allows only one text index per collection');
    }
  }
  for (const {className, field, indexName, spec, options} of fieldIndexes) {
    const specStr = typeof spec === 'string' ? `"${spec}"` : String(spec);
    const optParts = [`name: "${indexName}"`];
    for (const [k, v] of Object.entries(options)) {
      optParts.push(`${k}: ${JSON.stringify(v)}`);
    }
    console.log(`  db.${className}.createIndex({ ${field}: ${specStr} }, { ${optParts.join(', ')} })`);
  }
}
