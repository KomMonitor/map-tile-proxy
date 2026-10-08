export default async function metricsRoutes(app, { metrics }) {
  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.register.contentType);
    return metrics.register.metrics();
  });
}
