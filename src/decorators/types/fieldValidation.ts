import 'reflect-metadata';
import {classNames} from './schemaTypes';
import {catchError} from '../../utils/helper';

interface FieldMetadata {
  type: string;
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
  pattern?: string;
}

interface MongoDBValidatorProperty {
  bsonType?: string | string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  enum?: (string | null)[];
  pattern?: string;
  description?: string;
}

interface MongoDBValidator {
  $jsonSchema: {
    bsonType: 'object';
    properties: Record<string, MongoDBValidatorProperty>;
  };
}

interface ValidationInfo {
  className: string;
  validator: MongoDBValidator;
}

interface ValidationError {
  field: string;
  message: string;
  value?: any;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateObject(object: Parse.Object): ValidationResult {
  const className = object.className;
  const classConstructor = Parse.Object.extend(className);
  const fields: Record<string, FieldMetadata> =
    Reflect.getMetadata('parse:fields', classConstructor) || {};

  const errors: ValidationError[] = [];

  for (const [fieldName, meta] of Object.entries(fields)) {
    const value = object.get(fieldName);

    if (value === null || value === undefined) {
      if (meta.required) {
        errors.push({ field: fieldName, message: `Field '${fieldName}' is required` });
      }
      continue;
    }

    if (meta.type === 'Number' && typeof value === 'number') {
      if (meta.min !== undefined && value < meta.min) {
        errors.push({ field: fieldName, message: `Field '${fieldName}' must be at least ${meta.min}, got ${value}`, value });
      }
      if (meta.max !== undefined && value > meta.max) {
        errors.push({ field: fieldName, message: `Field '${fieldName}' must be at most ${meta.max}, got ${value}`, value });
      }
    }

    if (meta.type === 'String' && typeof value === 'string') {
      if (meta.minLength !== undefined && value.length < meta.minLength) {
        errors.push({ field: fieldName, message: `Field '${fieldName}' must have at least ${meta.minLength} characters, got ${value.length}`, value });
      }
      if (meta.maxLength !== undefined && value.length > meta.maxLength) {
        errors.push({ field: fieldName, message: `Field '${fieldName}' must have at most ${meta.maxLength} characters, got ${value.length}`, value });
      }
      if (meta.enum !== undefined && !meta.enum.includes(value)) {
        errors.push({ field: fieldName, message: `Field '${fieldName}' must be one of: ${meta.enum.join(', ')}. Got '${value}'`, value });
      }
      if (meta.pattern !== undefined) {
        const regex = new RegExp(meta.pattern);
        if (!regex.test(value)) {
          errors.push({ field: fieldName, message: `Field '${fieldName}' must match pattern: ${meta.pattern}. Got '${value}'`, value });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateOrThrow(object: Parse.Object): void {
  const result = validateObject(object);
  if (!result.valid) {
    const messages = result.errors.map(e => e.message).join('; ');
    throw new Parse.Error(Parse.Error.VALIDATION_ERROR, messages);
  }
}

function buildValidator(className: string): MongoDBValidator | null {
  const classConstructor = Parse.Object.extend(className);
  const fields: Record<string, FieldMetadata> =
    Reflect.getMetadata('parse:fields', classConstructor) || {};

  const properties: Record<string, MongoDBValidatorProperty> = {};
  let hasValidation = false;

  for (const [fieldName, meta] of Object.entries(fields)) {
    if (meta.type === 'Number' && (meta.min !== undefined || meta.max !== undefined)) {
      hasValidation = true;
      properties[fieldName] = {
        bsonType: ['int', 'long', 'double', 'decimal', 'null'],
        ...(meta.min !== undefined && {minimum: meta.min}),
        ...(meta.max !== undefined && {maximum: meta.max}),
      };
    }
    if (meta.type === 'String' && (meta.minLength !== undefined || meta.maxLength !== undefined || meta.enum !== undefined || meta.pattern !== undefined)) {
      hasValidation = true;
      properties[fieldName] = {
        bsonType: ['string', 'null'],
        ...(meta.minLength !== undefined && {minLength: meta.minLength}),
        ...(meta.maxLength !== undefined && {maxLength: meta.maxLength}),
        ...(meta.enum !== undefined && {enum: [...meta.enum, null]}),
        ...(meta.pattern !== undefined && {pattern: meta.pattern}),
      };
    }
  }

  if (!hasValidation) return null;

  return { $jsonSchema: { bsonType: 'object', properties } };
}

export function getValidators(): ValidationInfo[] {
  const validators: ValidationInfo[] = [];
  for (const className of classNames) {
    const validator = buildValidator(className);
    if (validator) validators.push({className, validator});
  }
  return validators;
}

export async function applyMongoValidators(parseServerInstance?: any): Promise<void> {
  const validators = getValidators();
  if (validators.length === 0) {
    console.log('[Validators] No MongoDB validators to apply');
    return;
  }

  console.log(`[Validators] Applying ${validators.length} MongoDB validator(s)...`);

  try {
    const config = parseServerInstance?.config;
    const adapter = config?.databaseController?.adapter || config?.database?.adapter;
    const db = adapter?.database || adapter?.client?.db() || adapter?.mongoClient?.db();

    if (!db) {
      console.warn('[Validators] Could not access database adapter.');
      return;
    }

    for (const {className, validator} of validators) {
      const [validatorErr] = await catchError(
        db.command({
          collMod: className,
          validator: validator,
          validationLevel: 'moderate',
          validationAction: 'error',
        })
      );
      if (validatorErr) {
        if ((validatorErr as any).codeName === 'NamespaceNotFound') {
          console.log(`[Validators] Collection ${className} doesn't exist yet`);
        } else {
          console.error(`[Validators] Failed for ${className}:`, (validatorErr as any).message);
        }
      } else {
        console.log(`[Validators] Applied validator for: ${className}`);
      }
    }
  } catch (error: any) {
    console.error('[Validators] Error:', error.message);
  }
}
