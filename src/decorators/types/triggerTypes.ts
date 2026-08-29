import {ClassNameType} from './schemaTypes';

export type TriggerType =
  | 'beforeSave' | 'afterSave' | 'beforeDelete' | 'afterDelete'
  | 'beforeFind' | 'afterFind'
  | 'beforeLogin' | 'afterLogin' | 'afterLogout' | 'beforePasswordResetRequest'
  | 'beforeSaveFile' | 'afterSaveFile' | 'beforeDeleteFile' | 'afterDeleteFile'
  | 'beforeFindFile' | 'afterFindFile'
  | 'beforeSaveConfig' | 'afterSaveConfig'
  | 'beforeConnect' | 'beforeSubscribe' | 'afterEvent';

export interface TriggerMetadata {
  type: TriggerType;
  className: ClassNameType;
  handler: Function;
  description?: string;
  validation?: Parse.Cloud.Validator;
}

export interface TriggerConfig {
  description?: string;
  validation?: Parse.Cloud.Validator;
}
