import {Express} from 'express';
import {generateSwaggerSpec, SwaggerConfig} from './swaggerSpec';
import {SwaggerRegistry} from './swaggerRegistry';

export {SwaggerRegistry} from './swaggerRegistry';
export {generateSwaggerSpec, getSwaggerJson} from './swaggerSpec';

/**
 * `swagger-ui-express` is optional, so it is reached for only when the UI is
 * actually being mounted.
 *
 * It used to be a top-level import, which made it mandatory in practice: the
 * package root re-exports `setupSwagger`, so importing anything at all from the
 * kit loaded this module and threw `MODULE_NOT_FOUND` for a dependency the docs
 * called optional. Requiring it here, the way `node-cron` is handled, makes the
 * promise true.
 */
function loadSwaggerUi(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('swagger-ui-express');
  } catch {
    return null;
  }
}

/**
 * Setup Swagger UI for the Express app.
 *
 * The spec itself has no dependencies, so `{path}/json` is served whether or not
 * the UI package is installed — a missing `swagger-ui-express` costs you the
 * browser page, not the document.
 */
export function setupSwagger(
  app: Express,
  config: SwaggerConfig,
  path: string = '/api-docs'
) {
  // Generate once, then reuse until something registers.
  //
  // The spec was rebuilt from every model and every endpoint on each hit of
  // `{path}/json` — walking the whole registry to produce a document that had
  // not changed since boot. Keyed on the registry's revision rather than a flag,
  // so late registration still invalidates it and nothing has to remember to.
  let cached: {revision: number; spec: object} | null = null;
  const getSpec = () => {
    const revision = SwaggerRegistry.getRevision();
    if (!cached || cached.revision !== revision) {
      cached = {revision, spec: generateSwaggerSpec(config)};
    }
    return cached.spec;
  };

  // Serve Swagger JSON BEFORE the UI middleware (so it doesn't get caught)
  app.get(`${path}/json`, (req, res) => {
    res.json(getSpec());
  });
  console.log(`[Swagger] API spec available at ${path}/json`);

  const swaggerUi = loadSwaggerUi();
  if (!swaggerUi) {
    console.warn(
      `[Swagger] swagger-ui-express not installed — serving the spec at ${path}/json only. ` +
        'Install it to get the browser UI.'
    );
    return;
  }

  // Serve Swagger UI
  app.use(
    path,
    swaggerUi.serve,
    swaggerUi.setup(null, {
      swaggerOptions: {
        url: `${path}/json`,
        persistAuthorization: true,
      },
      customSiteTitle: config.title || 'API Documentation',
    })
  );

  console.log(`[Swagger] API documentation available at ${path}`);
}
