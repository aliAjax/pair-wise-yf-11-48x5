const http = require("http");
const { handle } = require("./src/api");

const PORT = Number(process.env.PORT || 3020);

const server = http.createServer((req, res) => {
  handle(req, res);
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
