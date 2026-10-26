// App mínima sin dependencias: responde en PORT y muestra si recibió las variables del Secret.
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, app: 'node-app', hasDbPass: Boolean(process.env.DB_PASS), path: req.url }));
  })
  .listen(port, () => console.log(`Escuchando en ${port}`));
