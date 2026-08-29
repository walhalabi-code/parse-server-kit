/**
 * Application-shaped types that predate this library being a library.
 *
 * None of them describe anything Parse Server or this toolkit does — they are
 * conventions from the project this code grew out of, and they are kept only so
 * existing imports keep resolving. Declare your own equivalents; yours will fit
 * your application, and these will be removed in the next major version.
 */

/** @deprecated Declare your own. Not used by anything in this library. */
export interface AuthRole {
  id: string;
  name: string;
}

/**
 * @deprecated Declare your own. This hardcodes Arabic and English, which is one
 * project's language pair rather than a property of Parse Server. A localised
 * field is better typed as `Record<string, string>`, or as a union of the
 * locales your application actually supports.
 */
export interface MultiLangs {
  ar?: string;
  en?: string;
}

/** @deprecated Declare your own. Not used by anything in this library. */
export interface Filter {
  key: string;
  value: string | number | string[];
  type: 'string' | 'min' | 'max' | 'array' | 'text' | 'dropdown';
}
