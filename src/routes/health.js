export default async function healthRoutes(app) {
  app.get('/healthz', async (_req, reply) => {
    reply.code(200).send({ status: 'ok' });
  });
}
