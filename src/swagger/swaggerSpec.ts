import {SwaggerRegistry} from './swaggerRegistry';
import {kitConfig} from '../config';

export interface SwaggerConfig {
  title: string;
  version: string;
  description?: string;
  basePath?: string;
  host?: string;
  schemes?: string[];
  /** If true, include Parse Server CRUD endpoints (/classes/*, /login, /users, etc.). Defaults to false. */
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

    // Build security requirements (applicationId and restApiKey are always required)
    const security = func.requiresAuth
      ? [
          {applicationId: [], restApiKey: [], sessionToken: []},
          {applicationId: [], restApiKey: [], masterKey: []},
        ]
      : [{applicationId: [], restApiKey: []}];

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
          description: 'Parse Application ID',
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
        restApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Parse-REST-API-Key',
          description: 'REST API key for client requests',
        },
      },
    },
    security: [{applicationId: []}, {restApiKey: []}],
  };

  return spec;
}

/**
 * Get the Swagger specification as JSON
 */
export function getSwaggerJson(config: SwaggerConfig): string {
  return JSON.stringify(generateSwaggerSpec(config), null, 2);
}
