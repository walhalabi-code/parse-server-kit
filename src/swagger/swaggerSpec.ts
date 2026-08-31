import {SwaggerRegistry} from './swaggerRegistry';
import {kitConfig} from '../config';

export interface SwaggerConfig {
  title: string;
  version: string;
  description?: string;
  basePath?: string;
  host?: string;
  schemes?: string[];

  /**
   * This server's Parse application id, shown in the docs.
   *
   * Every request needs `X-Parse-Application-Id`, and a reader of the page has
   * no way to know what to put there — so they guess, and a wrong guess comes
   * back as a bare `{"error":"unauthorized"}` that names nothing. Passing it
   * here puts the value in the security scheme's description, where the
   * Authorize dialog shows it.
   *
   * It is not a secret: the app id is sent by every client on every request.
   * The master key is the secret, and that is never rendered here.
   */
  appId?: string;

  /**
   * Whether this server requires `X-Parse-REST-API-Key`. Default `false`.
   *
   * Parse Server only enforces it when `restAPIKey` is configured, which most
   * deployments — and every project `psk new` generates — do not. The spec used
   * to demand it unconditionally, which put a dead header in every example the
   * docs produced and implied a gate that was not there.
   *
   * Set it to `true` when you have configured one, and the docs will ask for it.
   */
  restApiKey?: boolean;
}

/**
 * Generate OpenAPI 3.0 specification from registered metadata
 */
export function generateSwaggerSpec(config: SwaggerConfig) {
  const models = SwaggerRegistry.getModels();
  const functions = SwaggerRegistry.getFunctions();

  // Build schemas from models
  const schemas: Record<string, any> = {};
  for (const model of models) {
    schemas[model.className] = {
      type: 'object',
      description: model.description,
      properties: model.properties,
      required: model.required.length > 0 ? model.required : undefined,
    };
  }

  // Add common schemas
  schemas['ParseError'] = {
    type: 'object',
    properties: {
      code: {type: 'number', description: 'Error code'},
      error: {type: 'string', description: 'Error message'},
    },
  };

  schemas['CloudFunctionRequest'] = {
    type: 'object',
    properties: {
      _ApplicationId: {type: 'string', description: 'Application ID'},
      _SessionToken: {
        type: 'string',
        description: 'Session token for authentication',
      },
    },
  };

  // Build paths from functions
  const paths: Record<string, any> = {};
  const tagSet = new Set<string>();

  for (const func of functions) {
    // Prefer the real @Route REST path; fall back to the legacy /functions/
    // route only for functions that have no @Route.
    const path = func.path ?? `/functions/${func.name}`;
    const method = func.method.toLowerCase();

    // Collect tags
    if (func.tags) {
      func.tags.forEach(tag => tagSet.add(tag));
    }

    // Build request body / query parameters from the declared fields. GET (and
    // HEAD) requests carry their fields in the QUERY STRING, not a body — so
    // emit `parameters: [{ in: 'query' }]` for them; everything else gets a JSON
    // requestBody. (Swagger UI / the browser cannot send a body on a GET.)
    const isQueryMethod = method === 'get' || method === 'head';
    let requestBody = undefined;
    let parameters: any[] | undefined = undefined;
    const hasFields =
      !!func.requestBody &&
      Object.keys(func.requestBody.properties).length > 0;

    if (hasFields && isQueryMethod) {
      parameters = Object.entries(func.requestBody!.properties).map(
        ([name, prop]: [string, any]) => {
          const {required, description, ...schema} = prop;
          return {
            name,
            in: 'query',
            required: !!required,
            description,
            schema: Object.keys(schema).length > 0 ? schema : {type: 'string'},
          };
        }
      );
    } else if (hasFields) {
      requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: func.requestBody!.properties,
              required: Object.entries(func.requestBody!.properties)
                .filter(([_, v]: [string, any]) => v.required)
                .map(([k]) => k),
            },
          },
        },
      };
    }

    // Build responses
    const responses: Record<string, any> = {};
    if (func.responses) {
      for (const [code, response] of Object.entries(func.responses)) {
        responses[code] = {
          description: response.description,
          content: response.schema
            ? {
                'application/json': {
                  schema: response.schema,
                },
              }
            : {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      result: {type: 'object', description: 'Function result'},
                    },
                  },
                },
              },
        };
      }
    }

    /*
     * The application id is always sent. The REST API key is only added when
     * the caller says this server has one — Parse ignores the header otherwise,
     * so demanding it put a header that does nothing into every example on the
     * page, and suggested a gate that was not there.
     */
    const base = config.restApiKey
      ? {applicationId: [], restApiKey: []}
      : {applicationId: []};

    const security = func.requiresAuth
      ? [
          {...base, sessionToken: []},
          {...base, masterKey: []},
        ]
      : [base];

    paths[path] = {
      ...paths[path],
      [method]: {
        tags: func.tags || ['Default'],
        summary: func.summary,
        description: func.description,
        operationId: func.name,
        security,
        parameters,
        requestBody,
        responses,
      },
    };
  }

  // Build tags array
  const tags = Array.from(tagSet).map(tag => ({
    name: tag,
    description: `${tag} related operations`,
  }));

  // Build final spec
  const spec = {
    openapi: '3.0.3',
    info: {
      title: config.title,
      version: config.version,
      description: config.description || 'Auto-generated API documentation',
    },
    servers: [
      {
        url: config.basePath || kitConfig().mountPath,
        description: 'Parse Server API',
      },
    ],
    tags,
    paths,
    components: {
      schemas,
      securitySchemes: {
        applicationId: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Parse-Application-Id',
          // Naming the value turns "unauthorized" from a puzzle into a typo.
          description: config.appId
            ? `Parse Application ID. This server: ${config.appId}`
            : 'Parse Application ID',
        },
        sessionToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Parse-Session-Token',
          description: 'User session token for authentication',
        },
        masterKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Parse-Master-Key',
          description: 'Master key for admin operations',
        },
        // Declared either way, so a reader can see the header exists; only
        // *required* when the server actually has a key.
        restApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Parse-REST-API-Key',
          description: config.restApiKey
            ? 'REST API key for client requests'
            : 'REST API key — this server does not require one',
        },
      },
    },
    security: config.restApiKey
      ? [{applicationId: []}, {restApiKey: []}]
      : [{applicationId: []}],
  };

  return spec;
}

/**
 * Get the Swagger specification as JSON
 */
export function getSwaggerJson(config: SwaggerConfig): string {
  return JSON.stringify(generateSwaggerSpec(config), null, 2);
}
