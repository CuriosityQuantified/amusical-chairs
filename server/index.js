import { createServer } from './app.js';

const PORT = Number(process.env.PORT) || 3000;
const { httpServer } = createServer();

httpServer.listen(PORT, () => {
  console.log(`Musical Chairs listening on http://localhost:${PORT}`);
  console.log('Host screen: /host.html — players join at / with the room code.');
});
